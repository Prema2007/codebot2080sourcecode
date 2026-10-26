const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const path = require("path");
const { AsyncLocalStorage } = require("node:async_hooks");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}));

app.use(express.urlencoded({
    extended: true
}));

const PORT = Number(
    process.env.PORT || 8000
);

const TOKEN =
    process.env.TOKEN || "";

const MYTOKEN =
    process.env.MYTOKEN || "";

const APP_SECRET =
    process.env.APP_SECRET || "";

const GRAPH_VERSION =
    process.env.GRAPH_VERSION || "v25.0";

const GOOGLE_MAPS_API_KEY =
    process.env.GOOGLE_MAPS_API_KEY || "";

const PUBLIC_BASE_URL =
    String(
        process.env.PUBLIC_BASE_URL ||
        "https://code-bot.in"
    ).replace(/\/+$/, "");

const SESSION_TIMEOUT_MS =
    30 * 60 * 1000;

const CATALOG_CACHE_MS =
    30 * 60 * 1000;

const merchantContext =
    new AsyncLocalStorage();

const sessions =
    new Map();

const catalogCache =
    new Map();

const conversationContexts =
    new Map();

const db = mysql.createPool({
    host:
        process.env.DB_HOST ||
        "127.0.0.1",

    user:
        process.env.DB_USER ||
        "",

    password:
        process.env.DB_PASSWORD ||
        "",

    database:
        process.env.DB_NAME ||
        "",

    waitForConnections:
        true,

    connectionLimit:
        10,

    queueLimit:
        0,

    decimalNumbers:
        true
});

async function query(
    sql,
    params = []
) {
    const [rows] =
        await db.execute(
            sql,
            params
        );

    return rows;
}

/* =========================================================
   MERCHANT CONTEXT
========================================================= */

function merchant() {

    const value =
        merchantContext.getStore();

    if (!value) {
        throw new Error(
            "Merchant context missing"
        );
    }

    return value;
}

function currentMerchantId() {
    return merchant().merchantId;
}

function currentChannelId() {
    return merchant().channelId;
}

function currentShopName() {
    return merchant().shopName;
}

function currentMerchantLogoUrl() {

    const merchantId =
        currentMerchantId();

    const specificEnv =
        process.env[
            `MERCHANT_LOGO_URL_${merchantId}`
        ];

    const genericEnv =
        process.env.MERCHANT_LOGO_URL;

    if (specificEnv) {
        return String(
            specificEnv
        ).trim();
    }

    if (genericEnv) {
        return String(
            genericEnv
        ).trim();
    }

    return null;
}

function currentProducts() {
    return merchant().products || [];
}

function currentUnits() {
    return merchant().units || [];
}

/* =========================================================
   STATES
========================================================= */

const STATES = {

    IDLE:
        "IDLE",

    PREORDER:
        "PREORDER",

    AWAITING_MORE:
        "AWAITING_MORE",

    AWAITING_EDIT:
        "AWAITING_EDIT",

    AWAITING_EDIT_DETAILS:
        "AWAITING_EDIT_DETAILS",

    AWAITING_ADDRESS_CHOICE:
        "AWAITING_ADDRESS_CHOICE",

    AWAITING_ADDRESS:
        "AWAITING_ADDRESS",

    FINAL:
        "FINAL",

    PROCESSING:
        "PROCESSING",

    COMPLETED:
        "COMPLETED"
};

/* =========================================================
   TEXT HELPERS
========================================================= */

function normalizeText(
    value
) {

    return String(
        value || ""
    )
        .toLowerCase()
        .trim()
        .replace(
            /[^\w\s.-]/g,
            " "
        )
        .replace(
            /\s+/g,
            " "
        );
}

const UNIT_ALIASES = {

    kg: "kg",
    kgs: "kg",
    kilo: "kg",
    kilos: "kg",
    kilogram: "kg",
    kilograms: "kg",

    g: "g",
    gm: "g",
    gms: "g",
    gram: "g",
    grams: "g",

    l: "ltr",
    lt: "ltr",
    ltr: "ltr",
    litre: "ltr",
    litres: "ltr",
    liter: "ltr",
    liters: "ltr",

    ml: "ml",
    millilitre: "ml",
    millilitres: "ml",
    milliliter: "ml",
    milliliters: "ml",

    pc: "pcs",
    pcs: "pcs",
    piece: "pcs",
    pieces: "pcs",

    no: "pcs",
    nos: "pcs",
    number: "pcs",

    pkt: "pkt",
    pk: "pkt",
    pkts: "pkt",
    packet: "pkt",
    packets: "pkt",

    pack: "pkt",
    packs: "pkt"
};

function normalizeUnit(
    value
) {

    if (!value) {
        return null;
    }

    const key =
        normalizeText(
            value
        );

    return (
        UNIT_ALIASES[key] ||
        key
    );
}

function unitDimension(
    unit
) {

    const u =
        normalizeUnit(
            unit
        );

    if (
        [
            "kg",
            "g"
        ].includes(u)
    ) {
        return "weight";
    }

    if (
        [
            "ltr",
            "ml"
        ].includes(u)
    ) {
        return "volume";
    }

    if (
        [
            "pcs",
            "pkt"
        ].includes(u)
    ) {
        return "count";
    }

    return null;
}

function productDimension(
    product,
    requestedUnit = null
) {

    const requested =
        unitDimension(
            requestedUnit
        );

    if (requested) {
        return requested;
    }

    const stockDimension =
        unitDimension(
            product?.stock_unit ||
            product?.unit_name
        );

    if (stockDimension) {
        return stockDimension;
    }

    const raw =
        normalizeText(
            product?.unit_type ||
            ""
        );

    const weight =
        /(^|[\/\s])(g|kg|gram|grams|kilogram|kilograms)([\/\s]|$)/i
            .test(raw);

    const volume =
        /(^|[\/\s])(ml|l|ltr|litre|liter|litres|liters)([\/\s]|$)/i
            .test(raw);

    const count =
        /(piece|pieces|pcs|packet|pack|pkt|set|pair|count|nos|number)/i
            .test(raw);

    if (count) {
        return "count";
    }

    if (
        weight &&
        !volume
    ) {
        return "weight";
    }

    if (
        volume &&
        !weight
    ) {
        return "volume";
    }

    return "count";
}

function defaultUnit(
    dimension
) {

    if (
        dimension ===
        "weight"
    ) {
        return "kg";
    }

    if (
        dimension ===
        "volume"
    ) {
        return "ltr";
    }

    return "pcs";
}

function findUnitId(
    unit
) {

    const wanted =
        normalizeUnit(
            unit
        );

    const row =
        currentUnits()
            .find(
                u =>
                    normalizeUnit(
                        u.short_name
                    ) === wanted ||

                    normalizeUnit(
                        u.unit_name
                    ) === wanted
            );

    return (
        row
            ? row.unit_id
            : null
    );
}

function quantityForStock(
    item
) {

    const qty =
        Number(
            item.qty || 0
        );

    const unit =
        normalizeUnit(
            item.unit
        );

    const dimension =
        item.unit_type ||
        productDimension(
            item,
            unit
        );

    if (
        dimension === "weight" &&
        unit === "g"
    ) {
        return qty / 1000;
    }

    if (
        dimension === "volume" &&
        unit === "ml"
    ) {
        return qty / 1000;
    }

    return qty;
}

function calculateItemTotal(
    item
) {

    const qty =
        Number(
            item.qty
        );

    const price =
        Number(
            item.unit_price ??
            item.selling_price
        );

    if (
        !Number.isFinite(qty) ||
        qty <= 0
    ) {

        throw new Error(
            "Quantity must be greater than 0."
        );
    }

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {

        throw new Error(
            "Invalid product price."
        );
    }

    const dimension =
        item.unit_type ||
        productDimension(
            item,
            item.unit
        );

    const unit =
        normalizeUnit(
            item.unit
        ) ||
        defaultUnit(
            dimension
        );

    let billingQty =
        qty;

    if (
        dimension === "weight" &&
        unit === "g"
    ) {
        billingQty =
            qty / 1000;
    }

    if (
        dimension === "volume" &&
        unit === "ml"
    ) {
        billingQty =
            qty / 1000;
    }

    item.unit_type =
        dimension;

    item.unit =
        unit;

    item.unit_id =
        findUnitId(
            unit
        ) ||
        item.unit_id ||
        null;

    item.total =
        Number(
            (
                price *
                billingQty
            ).toFixed(2)
        );

    return item.total;
}

function formatQty(
    value
) {

    const n =
        Number(
            value
        );

    if (
        !Number.isFinite(n)
    ) {
        return String(
            value || ""
        );
    }

    if (
        Number.isInteger(n)
    ) {
        return String(n);
    }

    return n
        .toFixed(3)
        .replace(
            /0+$/,
            ""
        )
        .replace(
            /\.$/,
            ""
        );
}

/* =========================================================
   PRODUCT SEARCH
========================================================= */

/*
 * STRICT PRODUCT MATCHING RULES
 *
 * 1. Minimum confidence = 80%
 * 2. Product name is trusted.
 * 3. Brand + product name can be used as one phrase.
 * 4. Genuine aliases can be used.
 * 5. Brand alone can NEVER create a product match.
 * 6. Category, description and package size are NOT used.
 * 7. Exact aliases must identify only one product.
 * 8. Ambiguous matches are rejected instead of choosing
 *    the first product from the database.
 */

const PRODUCT_MATCH_THRESHOLD = 0.80;
const PRODUCT_MATCH_AMBIGUITY_MARGIN = 0.08;


/* =========================================================
   SAFE SEARCH PHRASES
========================================================= */

function splitAliases(value) {

    return String(
        value || ""
    )
        .split(
            /[,|;]+/
        )
        .map(
            item =>
                normalizeText(
                    item
                )
        )
        .filter(
            Boolean
        );
}


function buildSearchTokens(row) {

    const phrases =
        new Set();

    const productName =
        normalizeText(
            row.product_name
        );

    const brandName =
        normalizeText(
            row.brand_name
        );


    /*
     * Product name is always searchable.
     */

    if (
        productName
    ) {

        phrases.add(
            productName
        );
    }


    /*
     * Brand is NEVER added alone.
     *
     * Example:
     *
     * Product = Cockroach Killer
     * Brand   = Exit No Entry
     *
     * "Exit" must NOT match.
     *
     * But:
     *
     * "Exit No Entry Cockroach Killer"
     *
     * may match because it is specific.
     */

    if (
        brandName &&
        productName
    ) {

        phrases.add(
            `${brandName} ${productName}`
        );
    }


    /*
     * Genuine aliases only.
     */

    for (
        const alias
        of splitAliases(
            row.aliases
        )
    ) {

        phrases.add(
            alias
        );
    }


    /*
     * DO NOT ADD:
     *
     * row.brand_name by itself
     * row.category_name
     * row.description
     * row.package_size
     */

    return [
        ...phrases
    ];
}


/* =========================================================
   PRODUCT VALIDATION
========================================================= */

function isUsableProduct(
    product
) {

    return Boolean(

        product &&

        Number(
            product.merchant_product_id ||
            product.vendor_product_id
        ) > 0 &&

        normalizeText(
            product.product_name
        ) !== "" &&

        Number.isFinite(
            Number(
                product.selling_price
            )
        ) &&

        Number(
            product.selling_price
        ) > 0
    );
}


/* =========================================================
   LEVENSHTEIN DISTANCE
   Used only for small spelling mistakes.
========================================================= */

function levenshteinDistance(
    a,
    b
) {

    const source =
        String(
            a || ""
        );

    const target =
        String(
            b || ""
        );

    const rows =
        source.length + 1;

    const cols =
        target.length + 1;

    const matrix =
        Array.from(
            {
                length:
                    rows
            },
            () =>
                new Array(
                    cols
                ).fill(0)
        );


    for (
        let i = 0;
        i < rows;
        i++
    ) {

        matrix[i][0] =
            i;
    }


    for (
        let j = 0;
        j < cols;
        j++
    ) {

        matrix[0][j] =
            j;
    }


    for (
        let i = 1;
        i < rows;
        i++
    ) {

        for (
            let j = 1;
            j < cols;
            j++
        ) {

            const cost =
                source[i - 1] ===
                target[j - 1]
                    ? 0
                    : 1;

            matrix[i][j] =
                Math.min(

                    matrix[i - 1][j] +
                    1,

                    matrix[i][j - 1] +
                    1,

                    matrix[i - 1][j - 1] +
                    cost
                );
        }
    }


    return matrix[
        source.length
    ][
        target.length
    ];
}


/* =========================================================
   CHARACTER SIMILARITY
========================================================= */

function characterSimilarity(
    a,
    b
) {

    const left =
        normalizeText(
            a
        );

    const right =
        normalizeText(
            b
        );


    if (
        !left ||
        !right
    ) {

        return 0;
    }


    if (
        left ===
        right
    ) {

        return 1;
    }


    const maxLength =
        Math.max(
            left.length,
            right.length
        );


    if (
        maxLength === 0
    ) {

        return 1;
    }


    const distance =
        levenshteinDistance(
            left,
            right
        );


    return Math.max(
        0,

        1 -
        (
            distance /
            maxLength
        )
    );
}


/* =========================================================
   WORD / PHRASE CONFIDENCE
========================================================= */

function productPhraseConfidence(
    query,
    candidate
) {

    const q =
        normalizeText(
            query
        );

    const c =
        normalizeText(
            candidate
        );


    if (
        !q ||
        !c
    ) {

        return 0;
    }


    /*
     * Exact phrase = 100%
     */

    if (
        q === c
    ) {

        return 1;
    }


    const queryWords =
        q
            .split(
                /\s+/
            )
            .filter(
                word =>
                    word.length >= 2
            );


    const candidateWords =
        c
            .split(
                /\s+/
            )
            .filter(
                word =>
                    word.length >= 2
            );


    if (
        !queryWords.length ||
        !candidateWords.length
    ) {

        return 0;
    }


    const candidateSet =
        new Set(
            candidateWords
        );


    let matchedWords =
        0;


    for (
        const word
        of queryWords
    ) {

        if (
            candidateSet.has(
                word
            )
        ) {

            matchedWords++;
        }
    }


    /*
     * Query coverage:
     * How much of what the CUSTOMER typed matched.
     */

    const queryCoverage =
        matchedWords /
        queryWords.length;


    /*
     * Candidate coverage:
     * How much of the PRODUCT phrase matched.
     *
     * This prevents:
     *
     * "Exit"
     *
     * from strongly matching:
     *
     * "Exit No Entry Cockroach Killer"
     */

    const candidateCoverage =
        matchedWords /
        candidateWords.length;


    /*
     * Customer words are more important,
     * but the candidate also needs to be reasonably close.
     */

    const wordScore =
        (
            queryCoverage *
            0.65
        ) +
        (
            candidateCoverage *
            0.35
        );


    /*
     * Character similarity allows small spelling mistakes.
     *
     * Examples:
     *
     * milk  -> milkk
     * atta  -> attaa
     */

    const charScore =
        characterSimilarity(
            q,
            c
        );


    /*
     * IMPORTANT:
     *
     * A one-word customer query must NOT automatically
     * select a longer multi-word product merely because
     * that word appears inside the product name.
     *
     * Examples:
     *
     * "atta" must NOT automatically become "Atta Bread".
     * "milk" must NOT automatically become "Milk Powder".
     *
     * A single-word query is accepted when:
     * - it exactly matches a unique product name, OR
     * - it exactly matches a unique alias, OR
     * - it is a strong spelling correction of a
     *   single-word product name.
     */

    if (
        queryWords.length === 1 &&
        candidateWords.length > 1
    ) {

        return (
            charScore >=
            PRODUCT_MATCH_THRESHOLD
                ? charScore
                : 0
        );
    }


    /*
     * If no complete word matched,
     * only a strong spelling similarity is accepted.
     */

    if (
        matchedWords === 0
    ) {

        return (
            charScore >=
            PRODUCT_MATCH_THRESHOLD
                ? charScore
                : 0
        );
    }


    return Math.max(
        wordScore,
        charScore
    );
}


/* =========================================================
   SAFE PRODUCT RESULT
========================================================= */

function matchedProduct(
    product,
    confidence,
    source
) {

    return {

        ...product,

        match_confidence:
            Number(
                confidence
            ),

        match_source:
            source
    };
}


/* =========================================================
   BLOCK NORMAL CHAT / CONTROL WORDS
========================================================= */

function isBlockedProductQuery(
    query
) {

    const blocked =
        new Set([
            "hi",
            "hii",
            "hiii",
            "hello",
            "hey",

            "ok",
            "okay",

            "yes",
            "no",

            "thanks",
            "thankyou",
            "thank you",

            "bye",
            "goodbye",

            "done",
            "great",
            "nice",
            "good",

            "confirm",

            "cancel",
            "reset",
            "clear cart",

            "cart",
            "view cart",
            "my cart",

            "good morning",
            "good afternoon",
            "good evening",
            "good night"
        ]);


    return blocked.has(
        query
    );
}


/* =========================================================
   FIND PRODUCT
========================================================= */

function findProduct(
    queryText
) {

    const query =
        normalizeText(
            queryText
        );

    if (!query) {
        return null;
    }

    /* Links can never be products. */
    if (
        /(?:https?:\/\/|www\.)/i.test(
            String(queryText || "")
        )
    ) {
        console.log(
            `❌ Product query rejected because it is a URL: "${query}"`
        );
        return null;
    }

    /* Normal chat/control words can never create a bill. */
    if (
        isBlockedProductQuery(query)
    ) {
        console.log(
            `❌ Blocked non-product text: "${query}"`
        );
        return null;
    }

    const products =
        currentProducts()
            .filter(isUsableProduct);

    if (!products.length) {
        return null;
    }

    /* =====================================================
       1. EXACT PRODUCT NAME
       Accept only when exactly one merchant product has it.
    ===================================================== */

    const exactNameMatches =
        products.filter(
            product =>
                normalizeText(product.product_name) === query
        );

    if (exactNameMatches.length === 1) {
        const product = exactNameMatches[0];

        console.log(
            `✅ Exact product match | Query="${query}" | Product="${product.product_name}" | Confidence=100%`
        );

        return matchedProduct(
            product,
            1,
            "exact_product_name"
        );
    }

    if (exactNameMatches.length > 1) {
        console.log(
            `⚠️ Ambiguous exact product name rejected | Query="${query}" | Matches=${exactNameMatches.length}`
        );
        return null;
    }

    /* =====================================================
       2. EXACT BRAND + PRODUCT NAME
       Brand alone is NEVER accepted.
       Example accepted: "Exit No Entry Cockroach Killer"
       Example rejected: "Exit" / "Exit No Entry"
    ===================================================== */

    const exactBrandProductMatches =
        products.filter(
            product => {
                const brand = normalizeText(product.brand_name);
                const name = normalizeText(product.product_name);

                if (!brand || !name) {
                    return false;
                }

                return `${brand} ${name}` === query;
            }
        );

    if (exactBrandProductMatches.length === 1) {
        const product = exactBrandProductMatches[0];

        console.log(
            `✅ Exact brand + product match | Query="${query}" | Product="${product.product_name}" | Confidence=100%`
        );

        return matchedProduct(
            product,
            1,
            "exact_brand_product"
        );
    }

    if (exactBrandProductMatches.length > 1) {
        console.log(
            `⚠️ Ambiguous brand + product match rejected | Query="${query}" | Matches=${exactBrandProductMatches.length}`
        );
        return null;
    }

    /* =====================================================
       3. EXACT UNIQUE ALIAS
       Aliases are NOT fuzzy-matched.
       An alias is accepted only if exactly one product owns it.
    ===================================================== */

    const exactAliasMatches = [];

    for (const product of products) {
        const brandWords = new Set(
            normalizeText(product.brand_name)
                .split(/\s+/)
                .filter(Boolean)
        );

        const aliases = splitAliases(product.aliases)
            .filter(alias => {
                const aliasWords = alias
                    .split(/\s+/)
                    .filter(Boolean);

                /*
                 * Do not treat a brand-only phrase as a product alias.
                 * Example: brand="Exit No Entry", alias="Exit".
                 */
                const aliasIsOnlyBrand =
                    aliasWords.length > 0 &&
                    brandWords.size > 0 &&
                    aliasWords.every(word => brandWords.has(word));

                return !aliasIsOnlyBrand;
            });

        if (aliases.some(alias => alias === query)) {
            exactAliasMatches.push(product);
        }
    }

    if (exactAliasMatches.length === 1) {
        const product = exactAliasMatches[0];

        console.log(
            `✅ Unique exact alias match | Query="${query}" | Product="${product.product_name}" | Confidence=100%`
        );

        return matchedProduct(
            product,
            1,
            "exact_alias"
        );
    }

    if (exactAliasMatches.length > 1) {
        console.log(
            `⚠️ Ambiguous exact alias rejected | Query="${query}" | Matches=${exactAliasMatches.length}`
        );
        return null;
    }

    /* =====================================================
       4. FUZZY CONFIDENCE SEARCH
       IMPORTANT: fuzzy search is against PRODUCT NAME ONLY.
       Brand/category/description/package/aliases cannot
       create a fuzzy product match.
    ===================================================== */

    let bestProduct = null;
    let bestScore = 0;
    let secondBestScore = 0;

    for (const product of products) {
        const score =
            productPhraseConfidence(
                query,
                product.product_name
            );

        if (score > bestScore) {
            secondBestScore = bestScore;
            bestScore = score;
            bestProduct = product;
        }
        else if (score > secondBestScore) {
            secondBestScore = score;
        }
    }

    /* Absolute 80% gate. */
    if (
        !bestProduct ||
        bestScore < PRODUCT_MATCH_THRESHOLD
    ) {
        console.log(
            `❌ Product rejected | Query="${query}" | Best confidence=${(bestScore * 100).toFixed(1)}%`
        );
        return null;
    }

    /*
     * If two strong products are too close, reject instead of
     * choosing whichever happens to appear first in the DB.
     */
    if (
        secondBestScore >= PRODUCT_MATCH_THRESHOLD &&
        (bestScore - secondBestScore) < PRODUCT_MATCH_AMBIGUITY_MARGIN
    ) {
        console.log(
            `⚠️ Ambiguous product rejected | Query="${query}" | Best=${(bestScore * 100).toFixed(1)}% | Second=${(secondBestScore * 100).toFixed(1)}%`
        );
        return null;
    }

    console.log(
        `✅ Product matched | Query="${query}" | Product="${bestProduct.product_name}" | Confidence=${(bestScore * 100).toFixed(1)}% | Source=product_name`
    );

    return matchedProduct(
        bestProduct,
        bestScore,
        "product_name"
    );
}

/* =========================================================
   PARSE QUANTITY
========================================================= */

function parseQuantity(
    text
) {

    const original =
        String(
            text || ""
        ).trim();


    /*
     * Quantity is accepted only at the END.
     *
     * This lets an exact product name ending in a number
     * match before the quantity parser is used.
     */

    const match =
        original.match(
            /(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|ltr|l|lt|litre|litres|liter|liters|ml|pcs|pc|piece|pieces|nos|no|pkt|pk|pkts|packet|pack|packs)?\s*$/i
        );


    if (
        !match
    ) {

        return {

            qty:
                1,

            unit:
                null,

            matchedText:
                ""
        };
    }


    return {

        qty:
            Number(
                match[1]
            ),

        unit:
            normalizeUnit(
                match[2]
            ),

        matchedText:
            match[0]
    };
}


/* =========================================================
   REMOVE QUANTITY FROM PRODUCT TEXT
========================================================= */

function cleanProductText(
    text,
    quantityInfo
) {

    const original =
        String(
            text || ""
        ).trim();

    const q =
        quantityInfo ||
        parseQuantity(
            original
        );


    if (
        !q.matchedText
    ) {

        return normalizeText(
            original
        );
    }


    return normalizeText(
        original.slice(
            0,
            original.length -
            q.matchedText.length
        )
    );
}


/* =========================================================
   PARSE SINGLE ORDER
========================================================= */

function parseSingleOrder(
    text
) {

    const original =
        String(
            text || ""
        ).trim();


    if (
        !original
    ) {

        return {
            error:
                "Empty product"
        };
    }


    const normalizedOriginal =
        normalizeText(
            original
        );


    /*
     * FIRST:
     * Check whether the entire user text is an exact
     * product name.
     *
     * This protects product names ending in numbers.
     *
     * Example:
     * "Product 2"
     *
     * should not automatically mean:
     * product="Product", qty=2.
     */

    const exactWholeMatches =
        currentProducts()
            .filter(
                isUsableProduct
            )
            .filter(
                product =>
                    normalizeText(
                        product.product_name
                    ) ===
                    normalizedOriginal
            );


    let q = {

        qty:
            1,

        unit:
            null,

        matchedText:
            ""
    };


    let productText =
        normalizedOriginal;


    let product =
        null;


    if (
        exactWholeMatches.length ===
        1
    ) {

        product =
            matchedProduct(
                exactWholeMatches[0],
                1,
                "exact_product_name"
            );
    }

    else if (
        exactWholeMatches.length >
        1
    ) {

        return {

            error:
                `Multiple products match "${original}". Please type the brand with the product name.`,

            requestedText:
                original
        };
    }

    else {

        q =
            parseQuantity(
                original
            );

        productText =
            cleanProductText(
                original,
                q
            );


        if (
            !productText
        ) {

            return {

                error:
                    `Product name is missing: ${original}`,

                requestedText:
                    original
            };
        }


        product =
            findProduct(
                productText
            );
    }


    if (
        !product ||
        !isUsableProduct(
            product
        )
    ) {

        return {

            error:
                `Product not found: ${productText || original}`,

            requestedText:
                original
        };
    }


    /*
     * Defense in depth:
     * No fuzzy result below 80% may enter the cart.
     */

    if (
        !Number.isFinite(
            Number(
                product.match_confidence
            )
        ) ||

        Number(
            product.match_confidence
        ) <
        PRODUCT_MATCH_THRESHOLD
    ) {

        return {

            error:
                `Product match is not confident enough: ${productText || original}`,

            requestedText:
                original
        };
    }


    const qty =
        Number(
            q.qty || 1
        );


    if (
        !Number.isFinite(qty) ||
        qty <= 0
    ) {

        return {

            error:
                `Invalid quantity for ${product.product_name}`,

            requestedText:
                original
        };
    }


    const dimension =
        productDimension(
            product,
            q.unit
        );


    const unit =
        normalizeUnit(
            q.unit
        ) ||
        defaultUnit(
            dimension
        );


    const requestedDimension =
        unitDimension(
            unit
        );


    const raw =
        normalizeText(
            product.unit_type ||
            ""
        );


    const hasWeight =
        /(^|[\/\s])(g|kg|gram|grams|kilogram|kilograms)([\/\s]|$)/i
            .test(
                raw
            );


    const hasVolume =
        /(^|[\/\s])(ml|l|ltr|litre|liter|litres|liters)([\/\s]|$)/i
            .test(
                raw
            );


    const hasCount =
        /(piece|pieces|pcs|packet|pack|pkt|set|pair|count|nos|number)/i
            .test(
                raw
            );


    if (
        requestedDimension ===
        "weight" &&
        hasVolume &&
        !hasWeight &&
        !hasCount
    ) {

        return {
            error:
                `${product.product_name} uses ml/ltr.`
        };
    }


    if (
        requestedDimension ===
        "volume" &&
        hasWeight &&
        !hasVolume &&
        !hasCount
    ) {

        return {
            error:
                `${product.product_name} uses g/kg.`
        };
    }


    if (
        requestedDimension !==
        "count" &&
        hasCount &&
        !hasWeight &&
        !hasVolume
    ) {

        return {
            error:
                `${product.product_name} is sold by piece/packet.`
        };
    }


    const item = {

        ...product,

        vendor_product_id:
            product.merchant_product_id ||
            product.vendor_product_id,

        merchant_product_id:
            product.merchant_product_id ||
            product.vendor_product_id,

        product_name:
            String(
                product.product_name
            ).trim(),

        unit_price:
            Number(
                product.selling_price
            ),

        match_confidence:
            Number(
                product.match_confidence
            ),

        match_source:
            product.match_source ||
            null,

        qty,

        unit,

        unit_type:
            dimension,

        unit_id:
            findUnitId(
                unit
            ) ||
            product.unit_id ||
            null
    };


    try {

        calculateItemTotal(
            item
        );

        return item;
    }

    catch (
        error
    ) {

        return {

            error:
                error.message,

            requestedText:
                original
        };
    }
}


/* =========================================================
   PARSE MULTIPLE ORDER ITEMS
========================================================= */

function parseOrderText(
    text
) {

    return String(
        text || ""
    )
        .split(
            /[,;\n]+/
        )
        .map(
            item =>
                item.trim()
        )
        .filter(
            Boolean
        )
        .map(
            parseSingleOrder
        );
}


/* =========================================================
   SESSION / CART
========================================================= */

function getSession(
    key
) {

    if (
        !sessions.has(
            key
        )
    ) {

        sessions.set(
            key,
            {
                status:
                    STATES.IDLE,

                chatStarted:
                    false,

                cart:
                    [],

                address:
                    null,

                addressId:
                    null,

                addressLatitude:
                    null,

                addressLongitude:
                    null,

                deliveryDistanceKm:
                    null,

                orderId:
                    null,

                orderNumber:
                    null,

                orderTotal:
                    null,

                conversationId:
                    null,

                editItemNo:
                    null,

                paymentProcessing:
                    false,

                lastActivity:
                    Date.now()
            }
        );
    }

    const session =
        sessions.get(
            key
        );

    if (
        Date.now() -
        Number(
            session.lastActivity || 0
        ) >
        SESSION_TIMEOUT_MS
    ) {

        resetConversation(
            session,
            true
        );
    }

    session.lastActivity =
        Date.now();

    return session;
}

function resetConversation(
    session,
    keepAddress = true
) {

    const address =
        keepAddress
            ? session.address
            : null;

    const addressId =
        keepAddress
            ? session.addressId
            : null;

    const addressLatitude =
        keepAddress
            ? session.addressLatitude
            : null;

    const addressLongitude =
        keepAddress
            ? session.addressLongitude
            : null;

    const deliveryDistanceKm =
        keepAddress
            ? session.deliveryDistanceKm
            : null;

    session.status =
        STATES.IDLE;

    session.chatStarted =
        false;

    session.cart =
        [];

    session.address =
        address;

    session.addressId =
        addressId;

    session.addressLatitude =
        addressLatitude;

    session.addressLongitude =
        addressLongitude;

    session.deliveryDistanceKm =
        deliveryDistanceKm;

    session.orderId =
        null;

    session.orderNumber =
        null;

    session.orderTotal =
        null;

    session.editItemNo =
        null;

    session.paymentProcessing =
        false;

    session.lastActivity =
        Date.now();
}

function renumberCart(
    session
) {

    (
        session.cart || []
    )
        .forEach(
            (
                item,
                index
            ) => {

                item.cartId =
                    index + 1;
            }
        );
}

function isValidCartItem(
    item
) {

    return Boolean(

        item &&

        Number(
            item.vendor_product_id
        ) > 0 &&

        normalizeText(
            item.product_name
        ) !== "" &&

        Number.isFinite(
            Number(
                item.unit_price
            )
        ) &&

        Number(
            item.unit_price
        ) > 0 &&

        Number.isFinite(
            Number(
                item.qty
            )
        ) &&

        Number(
            item.qty
        ) > 0 &&

        Number.isFinite(
            Number(
                item.match_confidence
            )
        ) &&

        Number(
            item.match_confidence
        ) >=
        PRODUCT_MATCH_THRESHOLD
    );
}

function cleanInvalidCartItems(
    session
) {

    session.cart =
        (
            session.cart || []
        )
            .filter(
                isValidCartItem
            );

    renumberCart(
        session
    );

    return session.cart;
}

function mergeSameProduct(
    existing,
    incoming
) {

    const existingDimension =
        existing.unit_type ||
        productDimension(
            existing,
            existing.unit
        );

    const incomingDimension =
        incoming.unit_type ||
        productDimension(
            incoming,
            incoming.unit
        );

    if (
        existingDimension !==
        incomingDimension
    ) {

        return {
            error:
                `Please use a compatible unit for ${incoming.product_name}.`
        };
    }

    if (
        existingDimension ===
        "weight"
    ) {

        const a =
            normalizeUnit(
                existing.unit
            ) === "g"
                ? Number(
                    existing.qty
                ) / 1000
                : Number(
                    existing.qty
                );

        const b =
            normalizeUnit(
                incoming.unit
            ) === "g"
                ? Number(
                    incoming.qty
                ) / 1000
                : Number(
                    incoming.qty
                );

        existing.qty =
            Number(
                (
                    a + b
                ).toFixed(4)
            );

        existing.unit =
            "kg";
    }

    else if (
        existingDimension ===
        "volume"
    ) {

        const a =
            normalizeUnit(
                existing.unit
            ) === "ml"
                ? Number(
                    existing.qty
                ) / 1000
                : Number(
                    existing.qty
                );

        const b =
            normalizeUnit(
                incoming.unit
            ) === "ml"
                ? Number(
                    incoming.qty
                ) / 1000
                : Number(
                    incoming.qty
                );

        existing.qty =
            Number(
                (
                    a + b
                ).toFixed(4)
            );

        existing.unit =
            "ltr";
    }

    else {

        const a =
            normalizeUnit(
                existing.unit
            ) || "pcs";

        const b =
            normalizeUnit(
                incoming.unit
            ) || "pcs";

        if (
            a !== b
        ) {

            return {
                error:
                    `Please use the same unit for ${incoming.product_name}.`
            };
        }

        existing.qty =
            Number(
                existing.qty
            ) +
            Number(
                incoming.qty
            );

        existing.unit =
            a;
    }

    existing.unit_id =
        findUnitId(
            existing.unit
        ) ||
        existing.unit_id ||
        null;

    calculateItemTotal(
        existing
    );

    return {
        ok: true,
        item: existing
    };
}

function addToCart(
    session,
    items
) {

    cleanInvalidCartItems(
        session
    );

    const result = {
        added: [],
        merged: [],
        errors: []
    };

    for (
        const item
        of items || []
    ) {

        if (
            !isValidCartItem(
                item
            )
        ) {

            result.errors.push(
                item?.error ||
                "Invalid product was not added."
            );

            continue;
        }

        const existing =
            session.cart.find(
                x =>
                    Number(
                        x.vendor_product_id
                    ) ===
                    Number(
                        item.vendor_product_id
                    )
            );

        if (existing) {

            const merged =
                mergeSameProduct(
                    existing,
                    item
                );

            if (
                merged.error
            ) {
                result.errors.push(
                    merged.error
                );
            }

            else {
                result.merged.push(
                    existing
                );
            }
        }

        else {

            session.cart.push({
                ...item
            });

            result.added.push(
                item
            );
        }
    }

    renumberCart(
        session
    );

    return result;
}

function cartOperationNote(
    operation
) {

    const lines = [];

    if (
        operation.added?.length
    ) {

        lines.push(
            `➕ Added: ${
                operation.added
                    .map(
                        x =>
                            x.product_name
                    )
                    .join(", ")
            }`
        );
    }

    if (
        operation.merged?.length
    ) {

        lines.push(
            `🔄 Quantity increased: ${
                operation.merged
                    .map(
                        x =>
                            x.product_name
                    )
                    .join(", ")
            }`
        );
    }

    if (
        operation.errors?.length
    ) {

        lines.push(
            `⚠️ ${
                operation.errors
                    .join(
                        "\n⚠️ "
                    )
            }`
        );
    }

    return lines.join(
        "\n"
    );
}

/* =========================================================
   CLEAN BILL UI
========================================================= */

function buildBill(
    items,
    title
) {

    const valid =
        (
            items || []
        )
            .filter(
                isValidCartItem
            );

    const lines = [
        `🧾 *${title}*`,
        ""
    ];

    let total =
        0;

    valid.forEach(
        (
            item,
            index
        ) => {

            const qty =
                formatQty(
                    item.qty
                );

            const unit =
                String(
                    item.unit || ""
                ).trim();

            const dimension =
                item.unit_type ||
                productDimension(
                    item,
                    unit
                );

            const rateUnit =
                dimension ===
                "weight"
                    ? "kg"
                    : dimension ===
                      "volume"
                        ? "ltr"
                        : (
                            unit ||
                            "pcs"
                        );

            const rate =
                Number(
                    item.unit_price || 0
                ).toFixed(2);

            const amount =
                Number(
                    item.total || 0
                ).toFixed(2);

            lines.push(
                `*${index + 1}. ${item.product_name}*`
            );

            lines.push(
                `Qty: ${qty} ${unit}`
            );

            lines.push(
                `Rate: ₹${rate} / ${rateUnit}`
            );

            lines.push(
                `Amount: *₹${amount}*`
            );

            lines.push("");

            total +=
                Number(
                    item.total || 0
                );
        }
    );

    lines.push(
        "━━━━━━━━━━━━━━━━━━"
    );

    lines.push(
        `💰 *Total: ₹${total.toFixed(2)}*`
    );

    return {

        text:
            lines.join("\n"),

        total:
            Number(
                total.toFixed(2)
            )
    };
}

function removeCartItem(
    session,
    itemNo
) {

    const index =
        session.cart.findIndex(
            x =>
                Number(
                    x.cartId
                ) ===
                Number(
                    itemNo
                )
        );

    if (
        index < 0
    ) {

        return {
            error:
                "Item number not found in cart."
        };
    }

    const [removed] =
        session.cart.splice(
            index,
            1
        );

    renumberCart(
        session
    );

    return {
        ok: true,
        removed
    };
}

function editCartItem(
    session,
    itemNo,
    qty,
    unit
) {

    const item =
        session.cart.find(
            x =>
                Number(
                    x.cartId
                ) ===
                Number(
                    itemNo
                )
        );

    if (!item) {

        return {
            error:
                "Item number not found in cart."
        };
    }

    const n =
        Number(
            qty
        );

    if (
        !Number.isFinite(n) ||
        n <= 0
    ) {

        return {
            error:
                "Quantity must be greater than 0."
        };
    }

    const nextUnit =
        normalizeUnit(
            unit
        ) ||
        item.unit;

    const d1 =
        item.unit_type ||
        productDimension(
            item,
            item.unit
        );

    const d2 =
        unitDimension(
            nextUnit
        ) ||
        d1;

    if (
        d1 !== d2
    ) {

        return {
            error:
                `Please use a ${d1} unit for ${item.product_name}.`
        };
    }

    item.qty =
        n;

    item.unit =
        nextUnit;

    item.unit_id =
        findUnitId(
            nextUnit
        ) ||
        item.unit_id ||
        null;

    calculateItemTotal(
        item
    );

    return {
        ok: true,
        item
    };
}
/* =========================================================
   MERCHANT + CATALOG
========================================================= */

async function getMerchantByNumber(
    phoneNumberId
) {

    const rows =
        await query(
            `
            SELECT
                c.channel_id,
                c.merchant_id,
                c.phone_number_id,
                c.display_number,
                c.status AS channel_status,
                m.store_name,
                m.registration_status

            FROM cb_merchant_channels c

            INNER JOIN cb_merchant_registration m
                ON m.merchant_id =
                   c.merchant_id

            WHERE c.phone_number_id = ?

              AND c.channel_type =
                  'whatsapp'

              AND c.status =
                  'active'

              AND m.registration_status
                  IN (
                      'approved',
                      'under_review'
                  )

            LIMIT 1
            `,
            [
                String(
                    phoneNumberId
                )
            ]
        );

    return (
        rows.length
            ? rows[0]
            : null
    );
}

async function loadMerchantCatalog(
    channel
) {

    const merchantId =
        Number(
            channel.merchant_id
        );

    const channelId =
        Number(
            channel.channel_id
        );

    const cacheKey =
        `${merchantId}:${channelId}`;

    const cached =
        catalogCache.get(
            cacheKey
        );

    if (
        cached &&
        Date.now() -
        cached.loadedAt <
        CATALOG_CACHE_MS
    ) {
        return cached;
    }

    const productRows =
        await query(
            `
            SELECT
                p.merchant_product_id,

                p.merchant_product_id
                    AS vendor_product_id,

                p.merchant_id,

                p.master_product_id,

                p.product_name,

                p.brand_name,

                p.description,

                p.merchant_sku,

                p.unit_id,

                p.unit_name,

                p.unit_value,

                p.package_size,

                p.selling_price,

                p.mrp,

                p.tax_rate,

                p.stock_tracking,

                p.stock_quantity,

                p.min_order_qty,

                p.qty_step,

                COALESCE(
                    NULLIF(
                        mp.unit_type,
                        ''
                    ),
                    u.unit_type,
                    p.unit_name
                )
                    AS unit_type,

                COALESCE(
                    NULLIF(
                        u.short_name,
                        ''
                    ),
                    p.unit_name
                )
                    AS stock_unit,

                COALESCE(
                    cat.category_name,
                    mp.category_name,
                    ''
                )
                    AS category_name,

                pi.image_key,

                CONCAT_WS(
                    ';',

                    NULLIF(
                        TRIM(
                            mp.aliases
                        ),
                        ''
                    ),

                    NULLIF(
                        pa.aliases_from_table,
                        ''
                    )
                )
                    AS aliases

            FROM cb_merchant_products p

            LEFT JOIN master_products mp
                ON mp.product_id =
                   p.master_product_id

            LEFT JOIN units u
                ON u.unit_id =
                   p.unit_id

            LEFT JOIN cb_merchant_catalog_categories cat
                ON cat.merchant_category_id =
                   p.merchant_category_id

               AND cat.merchant_id =
                   p.merchant_id

            LEFT JOIN
            (
                SELECT
                    merchant_product_id,

                    SUBSTRING_INDEX(
                        GROUP_CONCAT(
                            storage_key
                            ORDER BY
                                is_primary DESC,
                                sort_order ASC,
                                image_id ASC
                            SEPARATOR '||'
                        ),
                        '||',
                        1
                    ) AS image_key

                FROM cb_merchant_product_images

                WHERE status =
                      'active'

                GROUP BY merchant_product_id
            ) pi

                ON pi.merchant_product_id =
                   p.merchant_product_id

            LEFT JOIN
            (
                SELECT
                    product_id,

                    GROUP_CONCAT(
                        alias_name
                        SEPARATOR ';'
                    )
                        AS aliases_from_table

                FROM product_aliases

                GROUP BY product_id
            ) pa

                ON pa.product_id =
                   p.master_product_id

            WHERE p.merchant_id = ?

              AND p.is_available = 1

              AND p.status = 'active'

              AND TRIM(
                    COALESCE(
                        p.product_name,
                        ''
                    )
                  ) <> ''

              AND p.selling_price > 0

              AND
              (
                  p.stock_tracking = 0
                  OR
                  p.stock_quantity > 0
              )

              AND
              (
                  mp.product_id IS NULL
                  OR
                  mp.status = 'active'
              )

            ORDER BY
                p.product_name,
                p.merchant_product_id
            `,
            [
                merchantId
            ]
        );

    const products =
        productRows
            .map(
                row => ({
                    ...row,

                    selling_price:
                        Number(
                            row.selling_price
                        ),

                    stock_quantity:
                        Number(
                            row.stock_quantity
                        ),

                    searchTokens:
                        buildSearchTokens(
                            row
                        )
                })
            )
            .filter(
                isUsableProduct
            );

    const units =
        await query(
            `
            SELECT
                unit_id,
                unit_name,
                short_name,
                unit_type

            FROM units

            WHERE status = 'active'
               OR status IS NULL

            ORDER BY unit_id
            `
        );

    const result = {

        merchantId,

        channelId,

        phoneNumberId:
            String(
                channel.phone_number_id
            ),

        shopName:
            channel.store_name ||
            "CODE-Bot Store",

        registrationStatus:
            channel.registration_status,

        products,

        units,

        loadedAt:
            Date.now()
    };

    catalogCache.set(
        cacheKey,
        result
    );

    console.log(
        `✅ ${result.shopName}: ${products.length} valid products loaded`
    );

    return result;
}

function createLightweightMerchantContext(
    channel
) {

    return {

        merchantId:
            Number(
                channel.merchant_id
            ),

        channelId:
            Number(
                channel.channel_id
            ),

        phoneNumberId:
            String(
                channel.phone_number_id
            ),

        shopName:
            channel.store_name ||
            "CODE-Bot Store",

        registrationStatus:
            channel.registration_status,

        channel,

        products:
            [],

        units:
            [],

        catalogLoaded:
            false,

        loadedAt:
            0
    };
}

async function ensureCurrentCatalogLoaded() {

    const context =
        merchant();

    if (
        context.catalogLoaded
    ) {
        return context;
    }

    if (
        !context.channel
    ) {

        throw new Error(
            "Merchant channel context missing for catalog load."
        );
    }

    const loaded =
        await loadMerchantCatalog(
            context.channel
        );

    context.products =
        loaded.products ||
        [];

    context.units =
        loaded.units ||
        [];

    context.loadedAt =
        loaded.loadedAt ||
        Date.now();

    context.catalogLoaded =
        true;

    return context;
}

/* =========================================================
   CUSTOMER + CHAT DB
========================================================= */

async function ensureCustomer(
    phone
) {

    let rows =
        await query(
            `
            SELECT customer_id

            FROM customers

            WHERE whatsapp_number = ?

            LIMIT 1
            `,
            [
                phone
            ]
        );

    if (
        rows.length
    ) {
        return rows[0]
            .customer_id;
    }

    try {

        const result =
            await query(
                `
                INSERT INTO customers
                    (whatsapp_number)

                VALUES (?)
                `,
                [
                    phone
                ]
            );

        return result.insertId;
    }

    catch (
        error
    ) {

        if (
            error.code !==
            "ER_DUP_ENTRY"
        ) {
            throw error;
        }

        rows =
            await query(
                `
                SELECT customer_id

                FROM customers

                WHERE whatsapp_number = ?

                LIMIT 1
                `,
                [
                    phone
                ]
            );

        if (
            rows.length
        ) {
            return rows[0]
                .customer_id;
        }

        throw error;
    }
}

async function ensureConversation(
    merchantId,
    customerId,
    channelId
) {

    const rows =
        await query(
            `
            SELECT conversation_id

            FROM cb_conversations

            WHERE merchant_id = ?

              AND customer_id = ?

              AND channel_id = ?

              AND status = 'open'

            ORDER BY
                conversation_id DESC

            LIMIT 1
            `,
            [
                merchantId,
                customerId,
                channelId
            ]
        );

    if (
        rows.length
    ) {

        const id =
            rows[0]
                .conversation_id;

        await query(
            `
            UPDATE cb_conversations

            SET last_message_at =
                NOW()

            WHERE conversation_id = ?
            `,
            [
                id
            ]
        );

        return id;
    }

    const result =
        await query(
            `
            INSERT INTO cb_conversations
            (
                merchant_id,
                customer_id,
                channel_id,
                status,
                started_at,
                last_message_at
            )

            VALUES
            (
                ?,
                ?,
                ?,
                'open',
                NOW(),
                NOW()
            )
            `,
            [
                merchantId,
                customerId,
                channelId
            ]
        );

    return result.insertId;
}

function conversationKey(
    phoneNumberId,
    customerPhone
) {

    return (
        `${phoneNumberId}:${customerPhone}`
    );
}

function setConversationContext(
    phoneNumberId,
    customerPhone,
    conversationId
) {

    conversationContexts.set(
        conversationKey(
            phoneNumberId,
            customerPhone
        ),
        {
            conversationId:
                Number(
                    conversationId
                )
        }
    );
}

function getConversationContext(
    phoneNumberId,
    customerPhone
) {

    return (
        conversationContexts.get(
            conversationKey(
                phoneNumberId,
                customerPhone
            )
        ) ||
        null
    );
}

function inboundText(
    message,
    parsedText
) {

    if (
        parsedText
    ) {
        return String(
            parsedText
        );
    }

    if (
        message?.type ===
        "text"
    ) {

        return String(
            message.text?.body ||
            ""
        );
    }

    if (
        message?.type ===
        "interactive"
    ) {

        return String(
            message
                .interactive
                ?.button_reply
                ?.title ||

            message
                .interactive
                ?.list_reply
                ?.title ||

            message
                .interactive
                ?.button_reply
                ?.id ||

            message
                .interactive
                ?.list_reply
                ?.id ||

            ""
        );
    }

    if (
        message?.type ===
        "location"
    ) {

        const lat =
            Number(
                message.location
                    ?.latitude
            );

        const lng =
            Number(
                message.location
                    ?.longitude
            );

        const address =
            String(
                message.location
                    ?.address ||

                message.location
                    ?.name ||

                ""
            ).trim();

        if (
            Number.isFinite(lat) &&
            Number.isFinite(lng)
        ) {

            return (
                `Location: ${lat}, ${lng}${
                    address
                        ? ` | ${address}`
                        : ""
                }`
            );
        }
    }

    return "";
}

async function isMessageAlreadySaved(
    externalMessageId
) {

    if (
        !externalMessageId
    ) {
        return false;
    }

    const rows =
        await query(
            `
            SELECT message_id

            FROM cb_messages

            WHERE external_message_id = ?

            LIMIT 1
            `,
            [
                externalMessageId
            ]
        );

    return (
        rows.length > 0
    );
}

async function claimInboundMessage(
    conversationId,
    message,
    parsedText
) {

    const providerTimestamp =
        message?.timestamp
            ? new Date(
                Number(
                    message.timestamp
                ) *
                1000
            )
            : new Date();

    const result =
        await query(
            `
            INSERT IGNORE INTO cb_messages
            (
                conversation_id,
                external_message_id,
                reply_to_external_message_id,
                direction,
                message_type,
                message_text,
                payload_json,
                provider_status,
                provider_timestamp
            )

            VALUES
            (
                ?,
                ?,
                ?,
                'inbound',
                ?,
                ?,
                ?,
                'received',
                ?
            )
            `,
            [
                conversationId,

                message?.id ||
                null,

                message?.context?.id ||
                null,

                message?.type ||
                "text",

                inboundText(
                    message,
                    parsedText
                ) ||
                null,

                JSON.stringify(
                    message || {}
                ),

                providerTimestamp
            ]
        );

    await query(
        `
        UPDATE cb_conversations

        SET last_message_at =
            NOW()

        WHERE conversation_id = ?
        `,
        [
            conversationId
        ]
    );

    if (
        !message?.id
    ) {
        return true;
    }

    return (
        Number(
            result.affectedRows || 0
        ) === 1
    );
}

async function saveOutboundMessage(
    conversationId,
    response,
    messageType,
    messageText,
    payload
) {

    const externalId =
        response?.data
            ?.messages?.[0]
            ?.id ||
        null;

    await query(
        `
        INSERT INTO cb_messages
        (
            conversation_id,
            external_message_id,
            direction,
            message_type,
            message_text,
            payload_json,
            provider_status,
            sent_at
        )

        VALUES
        (
            ?,
            ?,
            'outbound',
            ?,
            ?,
            ?,
            'accepted',
            NOW()
        )

        ON DUPLICATE KEY UPDATE

            provider_status =
                VALUES(
                    provider_status
                ),

            message_text =
                VALUES(
                    message_text
                ),

            payload_json =
                VALUES(
                    payload_json
                ),

            sent_at =
                COALESCE(
                    sent_at,
                    VALUES(
                        sent_at
                    )
                ),

            updated_at =
                CURRENT_TIMESTAMP
        `,
        [
            conversationId,

            externalId,

            messageType,

            messageText ||
            null,

            JSON.stringify(
                payload || {}
            )
        ]
    );
}

async function updateMessageStatus(
    status
) {

    const id =
        status?.id;

    const state =
        String(
            status?.status || ""
        );

    if (
        !id ||
        !state
    ) {
        return;
    }

    const when =
        status?.timestamp
            ? new Date(
                Number(
                    status.timestamp
                ) *
                1000
            )
            : new Date();

    const error =
        Array.isArray(
            status?.errors
        ) &&
        status.errors.length
            ? status.errors[0]
            : null;

    await query(
        `
        UPDATE cb_messages

        SET
            provider_status = ?,

            delivered_at =
                COALESCE(
                    ?,
                    delivered_at
                ),

            read_at =
                COALESCE(
                    ?,
                    read_at
                ),

            failed_at =
                COALESCE(
                    ?,
                    failed_at
                ),

            failure_code =
                COALESCE(
                    ?,
                    failure_code
                ),

            failure_message =
                COALESCE(
                    ?,
                    failure_message
                ),

            updated_at =
                CURRENT_TIMESTAMP

        WHERE external_message_id = ?

          AND direction =
              'outbound'
        `,
        [
            state,

            state === "delivered"
                ? when
                : null,

            state === "read"
                ? when
                : null,

            state === "failed"
                ? when
                : null,

            error?.code
                ? String(
                    error.code
                )
                : null,

            error?.message ||
            error?.title ||
            null,

            id
        ]
    );
}

/* =========================================================
   SEND WHATSAPP
========================================================= */

async function sendWhatsApp(
    phoneNumberId,
    to,
    payload,
    messageText = ""
) {

    if (!TOKEN) {

        throw new Error(
            "TOKEN missing in .env"
        );
    }

    const data = {

        messaging_product:
            "whatsapp",

        to,

        ...payload
    };

    const response =
        await axios.post(
            `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
            data,
            {
                headers: {

                    Authorization:
                        `Bearer ${TOKEN}`,

                    "Content-Type":
                        "application/json"
                },

                timeout:
                    15000
            }
        );

    try {

        const context =
            getConversationContext(
                phoneNumberId,
                to
            );

        if (
            context?.conversationId
        ) {

            await saveOutboundMessage(
                context.conversationId,
                response,
                payload.type || "text",
                messageText,
                data
            );
        }
    }

    catch (
        error
    ) {

        console.error(
            "Outbound DB save warning:",
            error.message
        );
    }

    return response;
}

function sendText(
    phoneNumberId,
    to,
    text
) {

    return sendWhatsApp(
        phoneNumberId,
        to,
        {
            type:
                "text",

            text: {
                body:
                    String(
                        text
                    ).slice(
                        0,
                        4096
                    )
            }
        },
        String(
            text
        )
    );
}

function getPublicMediaUrl(
    storageKey
) {

    const key =
        String(
            storageKey || ""
        ).trim();

    if (!key) {
        return null;
    }

    if (
        /^https?:\/\//i.test(
            key
        )
    ) {
        return key;
    }

    if (
        !PUBLIC_BASE_URL
    ) {
        return null;
    }

    return (
        `${PUBLIC_BASE_URL}/${key.replace(/^\/+/, "")}`
    );
}

async function sendImage(
    phoneNumberId,
    to,
    imageUrl,
    caption = ""
) {

    const url =
        String(
            imageUrl || ""
        ).trim();

    if (!url) {
        return null;
    }

    return sendWhatsApp(
        phoneNumberId,
        to,
        {
            type:
                "image",

            image: {

                link:
                    url,

                caption:
                    String(
                        caption || ""
                    ).slice(
                        0,
                        1024
                    )
            }
        },
        String(
            caption || ""
        )
    );
}

async function sendProductImages(
    phoneNumberId,
    from,
    items
) {

    const unique =
        [];

    const seen =
        new Set();

    for (
        const item
        of items || []
    ) {

        if (
            !isValidCartItem(
                item
            )
        ) {
            continue;
        }

        const id =
            Number(
                item.vendor_product_id
            );

        if (
            seen.has(
                id
            )
        ) {
            continue;
        }

        seen.add(
            id
        );

        if (
            item.image_key
        ) {
            unique.push(
                item
            );
        }

        if (
            unique.length >= 3
        ) {
            break;
        }
    }

    for (
        const item
        of unique
    ) {

        const imageUrl =
            getPublicMediaUrl(
                item.image_key
            );

        if (!imageUrl) {
            continue;
        }

        try {

            await sendImage(
                phoneNumberId,
                from,
                imageUrl,

                `🛍️ *${item.product_name}*\n₹${Number(
                    item.selling_price
                ).toFixed(2)}`
            );
        }

        catch (
            error
        ) {

            console.warn(
                `⚠️ Product image could not be sent for ${item.product_name}:`,
                error.response?.data ||
                error.message
            );
        }
    }
}

function sendButtons(
    phoneNumberId,
    to,
    text,
    buttons
) {

    const safeButtons =
        (
            buttons || []
        )
            .slice(
                0,
                3
            )
            .map(
                button => ({
                    type:
                        "reply",

                    reply: {

                        id:
                            String(
                                button.id
                            ),

                        title:
                            String(
                                button.title
                            ).slice(
                                0,
                                20
                            )
                    }
                })
            );

    return sendWhatsApp(
        phoneNumberId,
        to,
        {
            type:
                "interactive",

            interactive: {

                type:
                    "button",

                body: {
                    text:
                        String(
                            text
                        ).slice(
                            0,
                            1024
                        )
                },

                action: {
                    buttons:
                        safeButtons
                }
            }
        },
        String(
            text
        )
    );
}

/* =========================================================
   ADDRESS
========================================================= */

async function getAddress(
    customerId
) {

    const rows =
        await query(
            `
            SELECT
                id,
                address,
                landmark,
                latitude,
                longitude,
                name,
                phone,
                city,
                state,
                pincode,
                country_id,
                state_id,
                is_default

            FROM customer_address

            WHERE customer_id = ?

            ORDER BY
                is_default DESC,
                id DESC

            LIMIT 1
            `,
            [
                customerId
            ]
        );

    return (
        rows.length
            ? rows[0]
            : null
    );
}

async function getAddressById(
    customerId,
    addressId
) {

    const rows =
        await query(
            `
            SELECT
                id,
                address,
                landmark,
                latitude,
                longitude,
                name,
                phone,
                city,
                state,
                pincode,
                country_id,
                state_id,
                is_default

            FROM customer_address

            WHERE customer_id = ?

              AND id = ?

            LIMIT 1
            `,
            [
                customerId,
                addressId
            ]
        );

    return (
        rows.length
            ? rows[0]
            : null
    );
}

async function saveAddress(
    customerId,
    from,
    addressData
) {

    const data =
        addressData || {};

    await query(
        `
        UPDATE customer_address

        SET is_default = 0

        WHERE customer_id = ?
        `,
        [
            customerId
        ]
    );

    const result =
        await query(
            `
            INSERT INTO customer_address
            (
                customer_id,
                user_number,
                address,
                landmark,
                latitude,
                longitude,
                name,
                phone,
                city,
                state,
                pincode,
                is_default
            )

            VALUES
            (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                1
            )
            `,
            [
                customerId,

                from,

                data.address,

                data.landmark ||
                null,

                data.latitude ??
                null,

                data.longitude ??
                null,

                data.name ||
                null,

                data.phone ||
                from,

                data.city ||
                null,

                data.state ||
                null,

                data.pincode ||
                null
            ]
        );

    return result.insertId;
}

async function updateAddressCoordinates(
    addressId,
    geo
) {

    await query(
        `
        UPDATE customer_address

        SET
            latitude = ?,

            longitude = ?,

            city =
                COALESCE(
                    ?,
                    city
                ),

            state =
                COALESCE(
                    ?,
                    state
                ),

            pincode =
                COALESCE(
                    ?,
                    pincode
                )

        WHERE id = ?
        `,
        [
            geo.latitude,

            geo.longitude,

            geo.city ||
            null,

            geo.state ||
            null,

            geo.pincode ||
            null,

            addressId
        ]
    );
}

async function getMerchantDeliveryProfile(
    merchantId
) {

    const rows =
        await query(
            `
            SELECT
                ma.address_id,
                ma.address_line1,
                ma.address_line2,
                ma.landmark,
                ma.city,
                ma.state,
                ma.pincode,
                ma.country,
                ma.latitude,
                ma.longitude,
                bg.max_delivery_distance_km

            FROM cb_merchant_registration mr

            LEFT JOIN business_types bt
                ON bt.business_type_id =
                   mr.business_type_id

            LEFT JOIN cb_business_groups bg
                ON bg.business_group_id =
                   bt.business_group_id

               AND bg.status =
                   'active'

            LEFT JOIN cb_merchant_addresses ma
                ON ma.merchant_id =
                   mr.merchant_id

               AND ma.address_type =
                   'business'

               AND ma.is_primary =
                   1

            WHERE mr.merchant_id = ?

            ORDER BY
                ma.address_id DESC

            LIMIT 1
            `,
            [
                merchantId
            ]
        );

    if (
        !rows.length
    ) {

        throw new Error(
            "Merchant delivery address not found."
        );
    }

    const row =
        rows[0];

    const latitude =
        Number(
            row.latitude
        );

    const longitude =
        Number(
            row.longitude
        );

    const maxDistanceKm =
        Number(
            row.max_delivery_distance_km
        );

    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
    ) {

        throw new Error(
            "Merchant latitude/longitude is missing in cb_merchant_addresses."
        );
    }

    return {

        ...row,

        latitude,

        longitude,

        maxDistanceKm:
            Number.isFinite(
                maxDistanceKm
            ) &&
            maxDistanceKm > 0
                ? maxDistanceKm
                : null
    };
}

function addressComponent(
    components,
    type
) {

    const part =
        (
            components || []
        )
            .find(
                x =>
                    (
                        x.types || []
                    )
                        .includes(
                            type
                        )
            );

    return (
        part
            ? part.long_name
            : null
    );
}

async function geocodeAddress(
    addressText
) {

    const address =
        String(
            addressText || ""
        ).trim();

    if (!address) {

        throw new Error(
            "Address is empty."
        );
    }

    if (
        !GOOGLE_MAPS_API_KEY
    ) {

        throw new Error(
            "GOOGLE_MAPS_API_KEY is missing. Add it in .env, or send a WhatsApp location pin."
        );
    }

    const response =
        await axios.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            {
                params: {

                    address,

                    key:
                        GOOGLE_MAPS_API_KEY,

                    region:
                        "in"
                },

                timeout:
                    15000
            }
        );

    const payload =
        response.data || {};

    if (
        payload.status !==
        "OK" ||
        !payload.results?.length
    ) {

        throw new Error(
            `Address could not be located (${payload.status || "UNKNOWN"}).`
        );
    }

    const result =
        payload.results[0];

    const location =
        result.geometry?.location ||
        {};

    const latitude =
        Number(
            location.lat
        );

    const longitude =
        Number(
            location.lng
        );

    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
    ) {

        throw new Error(
            "Google Maps did not return valid coordinates for this address."
        );
    }

    return {

        address:
            result.formatted_address ||
            address,

        latitude,

        longitude,

        city:
            addressComponent(
                result.address_components,
                "locality"
            ) ||

            addressComponent(
                result.address_components,
                "administrative_area_level_2"
            ),

        state:
            addressComponent(
                result.address_components,
                "administrative_area_level_1"
            ),

        pincode:
            addressComponent(
                result.address_components,
                "postal_code"
            )
    };
}

async function reverseGeocodeCoordinates(
    latitude,
    longitude
) {

    const lat =
        Number(
            latitude
        );

    const lng =
        Number(
            longitude
        );

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
    ) {

        throw new Error(
            "Invalid latitude/longitude."
        );
    }

    if (
        !GOOGLE_MAPS_API_KEY
    ) {

        return {

            address:
                `Pinned location: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,

            latitude:
                lat,

            longitude:
                lng,

            city:
                null,

            state:
                null,

            pincode:
                null
        };
    }

    const response =
        await axios.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            {
                params: {

                    latlng:
                        `${lat},${lng}`,

                    key:
                        GOOGLE_MAPS_API_KEY
                },

                timeout:
                    15000
            }
        );

    const payload =
        response.data || {};

    if (
        payload.status !==
        "OK" ||
        !payload.results?.length
    ) {

        return {

            address:
                `Pinned location: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,

            latitude:
                lat,

            longitude:
                lng,

            city:
                null,

            state:
                null,

            pincode:
                null
        };
    }

    const result =
        payload.results[0];

    return {

        address:
            result.formatted_address ||
            `Pinned location: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,

        latitude:
            lat,

        longitude:
            lng,

        city:
            addressComponent(
                result.address_components,
                "locality"
            ) ||

            addressComponent(
                result.address_components,
                "administrative_area_level_2"
            ),

        state:
            addressComponent(
                result.address_components,
                "administrative_area_level_1"
            ),

        pincode:
            addressComponent(
                result.address_components,
                "postal_code"
            )
    };
}

function haversineDistanceKm(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const toRad =
        value =>
            Number(
                value
            ) *
            Math.PI /
            180;

    const earthRadiusKm =
        6371;

    const dLat =
        toRad(
            lat2 -
            lat1
        );

    const dLon =
        toRad(
            lon2 -
            lon1
        );

    const a =
        Math.sin(
            dLat / 2
        ) *
        Math.sin(
            dLat / 2
        ) +

        Math.cos(
            toRad(
                lat1
            )
        ) *

        Math.cos(
            toRad(
                lat2
            )
        ) *

        Math.sin(
            dLon / 2
        ) *

        Math.sin(
            dLon / 2
        );

    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(
                1 - a
            )
        );

    return (
        earthRadiusKm * c
    );
}

async function validateDeliveryDistance(
    addressData
) {

    const profile =
        await getMerchantDeliveryProfile(
            currentMerchantId()
        );

    const customerLat =
        Number(
            addressData.latitude
        );

    const customerLng =
        Number(
            addressData.longitude
        );

    if (
        !Number.isFinite(
            customerLat
        ) ||
        !Number.isFinite(
            customerLng
        )
    ) {

        throw new Error(
            "Customer latitude/longitude is missing."
        );
    }

    const distanceKm =
        haversineDistanceKm(
            profile.latitude,
            profile.longitude,
            customerLat,
            customerLng
        );

    const withinRange =
        profile.maxDistanceKm == null ||
        distanceKm <=
        profile.maxDistanceKm;

    return {

        withinRange,

        distanceKm:
            Number(
                distanceKm.toFixed(2)
            ),

        maxDistanceKm:
            profile.maxDistanceKm,

        merchantLatitude:
            profile.latitude,

        merchantLongitude:
            profile.longitude
    };
}

async function prepareSavedAddressForDistance(
    savedAddress
) {

    if (
        !savedAddress
    ) {
        return null;
    }

    let latitude =
        Number(
            savedAddress.latitude
        );

    let longitude =
        Number(
            savedAddress.longitude
        );

    let geo =
        null;

    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
    ) {

        geo =
            await geocodeAddress(
                savedAddress.address
            );

        latitude =
            geo.latitude;

        longitude =
            geo.longitude;

        await updateAddressCoordinates(
            savedAddress.id,
            geo
        );
    }

    return {

        ...savedAddress,

        address:
            geo?.address ||
            savedAddress.address,

        latitude,

        longitude,

        city:
            geo?.city ||
            savedAddress.city ||
            null,

        state:
            geo?.state ||
            savedAddress.state ||
            null,

        pincode:
            geo?.pincode ||
            savedAddress.pincode ||
            null
    };
}

function setSessionAddress(
    session,
    addressRow,
    distanceInfo
) {

    session.address =
        addressRow.address;

    session.addressId =
        addressRow.id ||
        null;

    session.addressLatitude =
        Number(
            addressRow.latitude
        );

    session.addressLongitude =
        Number(
            addressRow.longitude
        );

    session.deliveryDistanceKm =
        distanceInfo?.distanceKm ??
        null;
}

async function askAddressChoice(
    phoneNumberId,
    from,
    session,
    customerId
) {

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        session.status =
            STATES.IDLE;

        await sendText(
            phoneNumberId,
            from,
            "🛒 Your cart is empty."
        );

        return;
    }

    const savedAddress =
        await getAddress(
            customerId
        );

    if (
        !savedAddress
    ) {

        session.status =
            STATES.AWAITING_ADDRESS;

        await sendText(
            phoneNumberId,
            from,
            "📍 *Delivery Address*\n\n" +
            "No previous address is saved.\n\n" +
            "Please send your complete current address, or share your WhatsApp location pin."
        );

        return;
    }

    session.status =
        STATES.AWAITING_ADDRESS_CHOICE;

    await sendButtons(
        phoneNumberId,
        from,

        `📍 *Delivery Address*\n\n` +
        `Previous address:\n` +
        `${savedAddress.address}\n\n` +
        `Which address do you want to use for this order?`,

        [
            {
                id:
                    "USE_PREVIOUS_ADDRESS",

                title:
                    "🏠 Previous Address"
            },
            {
                id:
                    "USE_CURRENT_ADDRESS",

                title:
                    "📍 Current Address"
            }
        ]
    );
}

/* =========================================================
   WELCOME
========================================================= */

async function getMerchantWelcomeLocation(
    merchantId
) {

    const rows =
        await query(
            `
            SELECT
                address_line1,
                address_line2,
                landmark,
                city,
                state

            FROM cb_merchant_addresses

            WHERE merchant_id = ?

              AND address_type =
                  'business'

            ORDER BY
                is_primary DESC,
                address_id DESC

            LIMIT 1
            `,
            [
                merchantId
            ]
        );

    if (
        !rows.length
    ) {

        return {
            street: "",
            city: ""
        };
    }

    const row =
        rows[0];

    const firstLine =
        String(
            row.address_line1 || ""
        )
            .split(
                /\r?\n/
            )
            .map(
                value =>
                    value.trim()
            )
            .filter(
                Boolean
            )[0] ||
        "";

    const street =
        String(
            firstLine ||
            row.address_line2 ||
            row.landmark ||
            ""
        ).trim();

    const rawCity =
        String(
            row.city || ""
        ).trim();

    const city =
        rawCity
            ? rawCity
                .toLowerCase()
                .replace(
                    /\b\w/g,
                    letter =>
                        letter.toUpperCase()
                )
            : "";

    return {
        street,
        city
    };
}

function welcomeMessage(
    location = {}
) {

    const street =
        String(
            location.street || ""
        ).trim();

    const city =
        String(
            location.city || ""
        ).trim();

    const locationLine =
        [
            street,
            city
        ]
            .filter(
                Boolean
            )
            .join(", ");

    return (
        `*Welcome* to *${currentShopName()}*\n` +

        (
            locationLine
                ? `📍 ${locationLine}\n\n`
                : `\n`
        ) +

        `🛒 Thank you for choosing us for your everyday needs.\n\n` +

        `📥 *How to Order*\n` +

        `• Just Start Typing: *<Product Name> <Quantity Unit>*\n` +

        `• Example: *Whole Wheat Atta 5 Kg*, *Milk 1ltr*\n\n` +

        `• You can also type just the product name or items separated by a comma.\n\n` +

        `*Units*: kg, g, pcs, ml, ltr, pkt\n\n` +

        `*The Street Smart Operating System*\n` +

        `Powered By *CODE-Bot 2080*\n` +

        `A Product of *2080 Technologies Private Limited*`
    );
}

async function sendWelcomeMessage(
    phoneNumberId,
    from
) {

    let location = {
        street: "",
        city: ""
    };

    try {

        location =
            await getMerchantWelcomeLocation(
                currentMerchantId()
            );
    }

    catch (
        error
    ) {

        console.warn(
            "⚠️ Merchant welcome location warning:",
            error.message
        );
    }

    const message =
        welcomeMessage(
            location
        );

    const logoUrl =
        currentMerchantLogoUrl();

    if (
        logoUrl
    ) {

        try {

            await sendImage(
                phoneNumberId,
                from,
                logoUrl,
                message
            );

            return;
        }

        catch (
            error
        ) {

            console.warn(
                "⚠️ Merchant logo could not be sent; using text welcome:",
                error.response?.data ||
                error.message
            );
        }
    }

    await sendText(
        phoneNumberId,
        from,
        message
    );
}

/* =========================================================
   BILLS
========================================================= */

async function sendPreOrderBill(
    phoneNumberId,
    from,
    session,
    note = ""
) {

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        session.status =
            STATES.IDLE;

        await sendText(
            phoneNumberId,
            from,
            "❌ No valid product has been added yet.\n\n" +
            "Please type a product name.\n" +
            "Example: *Cake 1 pcs*"
        );

        return;
    }

    const bill =
        buildBill(
            session.cart,
            "Pre Order Bill"
        );

    let body =
        `🏪 *${currentShopName()}*\n\n`;

    if (note) {

        body +=
            `${note}\n\n`;
    }

    body +=
        bill.text;

    const buttons = [
        {
            id:
                "ADD_MORE_ITEMS",

            title:
                "➕ More Item"
        },

        {
            id:
                "EDIT_ITEM",

            title:
                "✏️ Edit Item"
        },

        {
            id:
                "GENERATE_FINAL_BILL",

            title:
                "✅ Confirm"
        }
    ];

    if (
        body.length > 900
    ) {

        await sendText(
            phoneNumberId,
            from,
            body
        );

        await sendButtons(
            phoneNumberId,
            from,

            `🛒 *Cart Total: ₹${bill.total.toFixed(2)}*\n\n` +
            `What would you like to do?`,

            buttons
        );
    }

    else {

        await sendButtons(
            phoneNumberId,
            from,
            body,
            buttons
        );
    }

    session.status =
        STATES.PREORDER;
}

async function sendEditMenu(
    phoneNumberId,
    from,
    session
) {

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        session.status =
            STATES.IDLE;

        await sendText(
            phoneNumberId,
            from,
            "🛒 Your cart is empty."
        );

        return;
    }

    let body =
        "✏️ *Edit Item*\n\n" +
        "Please type the item number you want to edit.\n\n";

    session.cart.forEach(
        item => {

            body +=
                `${item.cartId}. ${item.product_name} - ${formatQty(item.qty)} ${item.unit}\n`;
        }
    );

    body +=
        "\nExample: *1*";

    session.status =
        STATES.AWAITING_EDIT;

    await sendText(
        phoneNumberId,
        from,
        body
    );
}

async function sendEditAction(
    phoneNumberId,
    from,
    item
) {

    await sendButtons(
        phoneNumberId,
        from,

        `✏️ Editing item ${item.cartId}\n\n` +

        `Product: *${item.product_name}*\n` +

        `Current Quantity: *${formatQty(item.qty)} ${item.unit}*\n\n` +

        `Choose what you want to do:`,

        [
            {
                id:
                    `EDIT_QTY_${item.cartId}`,

                title:
                    "✏️ Edit Quantity"
            },

            {
                id:
                    `REMOVE_ITEM_${item.cartId}`,

                title:
                    "🗑️ Remove Product"
            },

            {
                id:
                    "BACK_TO_CART",

                title:
                    "↩️ Back to Cart"
            }
        ]
    );
}

async function sendFinalBill(
    phoneNumberId,
    from,
    session
) {

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        session.status =
            STATES.IDLE;

        await sendText(
            phoneNumberId,
            from,

            "❌ No valid product is available to generate the final bill.\n\n" +
            "Type *Chacha* to start again."
        );

        return;
    }

    if (
        !session.address ||

        !Number.isFinite(
            Number(
                session.addressLatitude
            )
        ) ||

        !Number.isFinite(
            Number(
                session.addressLongitude
            )
        )
    ) {

        await sendText(
            phoneNumberId,
            from,

            "📍 Please select or enter a delivery address before payment."
        );

        return;
    }

    const bill =
        buildBill(
            session.cart,
            "Final Bill"
        );

    let body =
        `🏪 *${currentShopName()}*\n\n` +

        `${bill.text}` +

        `\n\n📍 *Delivery Address*\n` +

        `${session.address}`;

    if (
        Number.isFinite(
            Number(
                session.deliveryDistanceKm
            )
        )
    ) {

        body +=
            `\n\n📏 Distance from store: *${Number(
                session.deliveryDistanceKm
            ).toFixed(2)} km*`;
    }

    body +=
        "\n🚚 Address is within the delivery area.";

    const buttons = [
        {
            id:
                "ADD_PAYMENT",

            title:
                "💳 Pay Now"
        }
    ];

    if (
        body.length > 900
    ) {

        await sendText(
            phoneNumberId,
            from,
            body
        );

        await sendButtons(
            phoneNumberId,
            from,

            `💰 *Total: ₹${bill.total.toFixed(2)}*\n` +

            `📍 Delivery address confirmed.\n\n` +

            `Tap below to continue.`,

            buttons
        );
    }

    else {

        await sendButtons(
            phoneNumberId,
            from,
            body,
            buttons
        );
    }

    session.status =
        STATES.FINAL;
}

/* =========================================================
   ORDER SAVE
========================================================= */

async function getPendingStatusId(
    connection
) {

    const [rows] =
        await connection.execute(
            `
            SELECT status_id

            FROM order_status

            WHERE status_code =
                  'pending'

            LIMIT 1
            `
        );

    return (
        rows.length
            ? rows[0].status_id
            : null
    );
}

async function saveOrder(
    session,
    from,
    customerId
) {

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        throw new Error(
            "No valid products in cart."
        );
    }

    const bill =
        buildBill(
            session.cart,
            "Final Bill"
        );

    if (
        bill.total <= 0
    ) {

        throw new Error(
            "Invalid order total."
        );
    }

    const connection =
        await db.getConnection();

    try {

        await connection.beginTransaction();

        const statusId =
            await getPendingStatusId(
                connection
            );

        const orderNumber =
            `ORD${Date.now()}${Math.floor(
                Math.random() * 10000
            )
                .toString()
                .padStart(
                    4,
                    "0"
                )}`;

        const [orderResult] =
            await connection.execute(
                `
                INSERT INTO cb_orders
                (
                    merchant_id,
                    customer_id,
                    channel_id,
                    conversation_id,
                    order_number,
                    source,
                    fulfillment_type,
                    status_id,
                    payment_status,
                    subtotal_amount,
                    total_amount,
                    remarks
                )

                VALUES
                (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    'whatsapp',
                    'delivery',
                    ?,
                    'pending',
                    ?,
                    ?,
                    ?
                )
                `,
                [
                    currentMerchantId(),

                    customerId,

                    currentChannelId(),

                    session.conversationId ||
                    null,

                    orderNumber,

                    statusId,

                    bill.total,

                    bill.total,

                    "WhatsApp bot order"
                ]
            );

        const orderId =
            orderResult.insertId;

        for (
            const item
            of session.cart
        ) {

            const [rows] =
                await connection.execute(
                    `
                    SELECT
                        merchant_product_id,
                        master_product_id,
                        product_name,
                        brand_name,
                        merchant_sku,
                        unit_name,
                        unit_value,
                        package_size,
                        selling_price,
                        mrp,
                        tax_rate,
                        stock_tracking,
                        stock_quantity,
                        is_available,
                        status

                    FROM cb_merchant_products

                    WHERE merchant_product_id = ?

                      AND merchant_id = ?

                    FOR UPDATE
                    `,
                    [
                        item.vendor_product_id,

                        currentMerchantId()
                    ]
                );

            if (
                !rows.length
            ) {

                throw new Error(
                    `${item.product_name} is no longer available.`
                );
            }

            const dbProduct =
                rows[0];

            if (
                dbProduct.status !==
                "active" ||

                !Number(
                    dbProduct.is_available
                ) ||

                normalizeText(
                    dbProduct.product_name
                ) === ""
            ) {

                throw new Error(
                    `${item.product_name} is no longer available.`
                );
            }

            if (
                Number(
                    dbProduct.selling_price
                ) !==
                Number(
                    item.unit_price
                )
            ) {

                throw new Error(
                    `Price changed for ${item.product_name}. Please restart the order.`
                );
            }

            const stockQty =
                quantityForStock(
                    item
                );

            if (
                Number(
                    dbProduct.stock_tracking
                ) &&

                Number(
                    dbProduct.stock_quantity
                ) <
                stockQty
            ) {

                throw new Error(
                    `Insufficient stock for ${item.product_name}.`
                );
            }

            await connection.execute(
                `
                INSERT INTO cb_order_items
                (
                    order_id,
                    merchant_id,
                    merchant_product_id,
                    master_product_id,
                    product_name,
                    brand_name,
                    merchant_sku,
                    unit_name,
                    unit_value,
                    package_size,
                    quantity,
                    unit_price,
                    mrp,
                    tax_rate,
                    line_subtotal,
                    line_total
                )

                VALUES
                (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?
                )
                `,
                [
                    orderId,

                    currentMerchantId(),

                    item.vendor_product_id,

                    dbProduct.master_product_id,

                    dbProduct.product_name,

                    dbProduct.brand_name,

                    dbProduct.merchant_sku,

                    item.unit,

                    dbProduct.unit_value,

                    dbProduct.package_size,

                    item.qty,

                    item.unit_price,

                    dbProduct.mrp,

                    dbProduct.tax_rate,

                    item.total,

                    item.total
                ]
            );

            if (
                Number(
                    dbProduct.stock_tracking
                )
            ) {

                await connection.execute(
                    `
                    UPDATE cb_merchant_products

                    SET stock_quantity =
                        stock_quantity - ?

                    WHERE merchant_product_id = ?

                      AND merchant_id = ?
                    `,
                    [
                        stockQty,

                        item.vendor_product_id,

                        currentMerchantId()
                    ]
                );
            }
        }

        let addressRows =
            [];

        if (
            session.addressId
        ) {

            [addressRows] =
                await connection.execute(
                    `
                    SELECT
                        id,
                        name,
                        phone,
                        address,
                        landmark,
                        city,
                        state,
                        pincode,
                        country_id,
                        state_id,
                        latitude,
                        longitude

                    FROM customer_address

                    WHERE customer_id = ?

                      AND id = ?

                    LIMIT 1
                    `,
                    [
                        customerId,
                        session.addressId
                    ]
                );
        }

        if (
            !addressRows.length
        ) {

            [addressRows] =
                await connection.execute(
                    `
                    SELECT
                        id,
                        name,
                        phone,
                        address,
                        landmark,
                        city,
                        state,
                        pincode,
                        country_id,
                        state_id,
                        latitude,
                        longitude

                    FROM customer_address

                    WHERE customer_id = ?

                    ORDER BY
                        is_default DESC,
                        id DESC

                    LIMIT 1
                    `,
                    [
                        customerId
                    ]
                );
        }

        const a =
            addressRows[0] ||
            {};

        await connection.execute(
            `
            INSERT INTO cb_order_address_snapshots
            (
                order_id,
                merchant_id,
                customer_address_id,
                recipient_name,
                recipient_phone,
                address_text,
                landmark,
                city,
                state,
                pincode,
                country_id,
                state_id,
                latitude,
                longitude
            )

            VALUES
            (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            )
            `,
            [
                orderId,

                currentMerchantId(),

                a.id ||
                null,

                a.name ||
                null,

                a.phone ||
                from,

                session.address,

                a.landmark ||
                null,

                a.city ||
                null,

                a.state ||
                null,

                a.pincode ||
                null,

                a.country_id ||
                null,

                a.state_id ||
                null,

                a.latitude ||
                null,

                a.longitude ||
                null
            ]
        );

        await connection.execute(
            `
            INSERT INTO cb_order_payments
            (
                order_id,
                merchant_id,
                payment_method,
                gateway,
                amount_paise,
                currency,
                status
            )

            VALUES
            (
                ?,
                ?,
                'manual',
                NULL,
                ?,
                'INR',
                'pending'
            )
            `,
            [
                orderId,

                currentMerchantId(),

                Math.round(
                    bill.total * 100
                )
            ]
        );

        await connection.commit();

        return {

            orderId,

            orderNumber,

            total:
                bill.total
        };
    }

    catch (
        error
    ) {

        await connection.rollback();

        throw error;
    }

    finally {

        connection.release();
    }
}
async function placePendingOrder(
    phoneNumberId,
    from,
    session,
    customerId
) {

    if (
        session.paymentProcessing ||
        session.orderId
    ) {
        return;
    }

    cleanInvalidCartItems(
        session
    );

    if (
        !session.cart.length
    ) {

        await sendText(
            phoneNumberId,
            from,
            "🛒 Your cart is empty."
        );

        return;
    }

    if (
        !session.address ||

        !Number.isFinite(
            Number(
                session.addressLatitude
            )
        ) ||

        !Number.isFinite(
            Number(
                session.addressLongitude
            )
        )
    ) {

        await askAddressChoice(
            phoneNumberId,
            from,
            session,
            customerId
        );

        return;
    }

    session.paymentProcessing =
        true;

    session.status =
        STATES.PROCESSING;

    try {

        const result =
            await saveOrder(
                session,
                from,
                customerId
            );

        session.orderId =
            result.orderId;

        session.orderNumber =
            result.orderNumber;

        session.orderTotal =
            result.total;

        session.status =
            STATES.COMPLETED;

        await sendText(
            phoneNumberId,
            from,

            `✅ *Order Placed! (Payment Pending)*\n\n` +

            `🧾 Order No: *${result.orderNumber}*\n` +

            `💰 Amount Due: *₹${result.total.toFixed(2)}*\n\n` +

            `📍 Delivery Address:\n${session.address}\n\n` +

            `Payment has NOT yet been received or verified.\n` +

            `Thank you for shopping with *${currentShopName()}* ❤️`
        );
    }

    catch (
        error
    ) {

        session.status =
            STATES.FINAL;

        console.error(
            "Order save failed:",
            error
        );

        await sendText(
            phoneNumberId,
            from,

            `❌ Could not place your order: ${error.message}`
        );
    }

    finally {

        session.paymentProcessing =
            false;
    }
}

/* =========================================================
   WEBHOOK SECURITY
========================================================= */

function verifySignature(
    req
) {

    if (!APP_SECRET) {
        return true;
    }

    const received =
        String(
            req.get(
                "x-hub-signature-256"
            ) || ""
        );

    const expected =
        "sha256=" +
        crypto
            .createHmac(
                "sha256",
                APP_SECRET
            )
            .update(
                req.rawBody ||
                Buffer.alloc(0)
            )
            .digest(
                "hex"
            );

    const a =
        Buffer.from(
            received
        );

    const b =
        Buffer.from(
            expected
        );

    return (
        a.length ===
        b.length &&

        crypto.timingSafeEqual(
            a,
            b
        )
    );
}

/* =========================================================
   WEBHOOK VERIFY
========================================================= */

app.get(
    "/webhook",
    (
        req,
        res
    ) => {

        const mode =
            req.query[
                "hub.mode"
            ];

        const token =
            req.query[
                "hub.verify_token"
            ];

        const challenge =
            req.query[
                "hub.challenge"
            ];

        if (
            mode ===
            "subscribe" &&

            token ===
            MYTOKEN
        ) {

            return res
                .status(200)
                .send(
                    challenge
                );
        }

        return res.sendStatus(
            403
        );
    }
);

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    phoneNumberId,
    message
) {

    const from =
        String(
            message.from || ""
        );

    if (!from) {
        return;
    }

    const session =
        getSession(
            `${phoneNumberId}:${from}`
        );

    let text =
        "";

    let buttonId =
        null;

    let location =
        null;

    if (
        message.type ===
        "text"
    ) {

        text =
            String(
                message.text?.body ||
                ""
            ).trim();
    }

    else if (
        message.type ===
        "location"
    ) {

        location = {

            latitude:
                Number(
                    message.location
                        ?.latitude
                ),

            longitude:
                Number(
                    message.location
                        ?.longitude
                ),

            name:
                String(
                    message.location
                        ?.name ||
                    ""
                ).trim(),

            address:
                String(
                    message.location
                        ?.address ||
                    ""
                ).trim()
        };
    }

    else if (
        message.type ===
        "interactive"
    ) {

        if (
            message.interactive
                ?.type ===
            "button_reply"
        ) {

            buttonId =
                String(
                    message
                        .interactive
                        .button_reply
                        .id ||
                    ""
                )
                    .trim()
                    .toUpperCase();

            text =
                String(
                    message
                        .interactive
                        .button_reply
                        .title ||
                    ""
                )
                    .trim();
        }

        else if (
            message.interactive
                ?.type ===
            "list_reply"
        ) {

            buttonId =
                String(
                    message
                        .interactive
                        .list_reply
                        .id ||
                    ""
                )
                    .trim()
                    .toUpperCase();

            text =
                String(
                    message
                        .interactive
                        .list_reply
                        .title ||
                    ""
                )
                    .trim();
        }
    }

    const customerId =
        await ensureCustomer(
            from
        );

    const conversationId =
        await ensureConversation(
            currentMerchantId(),
            customerId,
            currentChannelId()
        );

    session.conversationId =
        conversationId;

    setConversationContext(
        phoneNumberId,
        from,
        conversationId
    );

    let shouldProcess =
        true;

    try {

        shouldProcess =
            await claimInboundMessage(
                conversationId,
                message,
                text
            );
    }

    catch (
        error
    ) {

        console.error(
            "Inbound DB save warning:",
            error.message
        );

        shouldProcess =
            true;
    }

    if (
        !shouldProcess
    ) {

        console.log(
            `↩️ Duplicate WhatsApp message ignored: ${message.id}`
        );

        return;
    }

    /* =====================================================
       STRICT WELCOME
       ONLY EXACT Chacha / chacha
    ===================================================== */

    if (
        !buttonId &&
        (
            text === "Chacha" ||
            text === "chacha"
        )
    ) {

        resetConversation(
            session,
            false
        );

        session.chatStarted =
            true;

        await sendWelcomeMessage(
            phoneNumberId,
            from
        );

        return;
    }

    /* =====================================================
       IMPORTANT:
       NOTHING ELSE CAN PROCEED
       BEFORE CHACHA
    ===================================================== */

    if (
        !session.chatStarted
    ) {

        await sendText(
            phoneNumberId,
            from,

            "To Proceed Chat just Type *Chacha*."
        );

        return;
    }

    /* =====================================================
       COMPLETED
    ===================================================== */

    if (
        session.status ===
        STATES.COMPLETED
    ) {

        await sendText(
            phoneNumberId,
            from,

            "✅ Your previous order is already completed.\n\n" +

            "Type *Chacha* to start a new order."
        );

        return;
    }

    /* =====================================================
       MORE ITEM
    ===================================================== */

    if (
        buttonId ===
        "ADD_MORE_ITEMS"
    ) {

        if (
            session.status !==
            STATES.PREORDER
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        session.status =
            STATES.AWAITING_MORE;

        await sendText(
            phoneNumberId,
            from,

            "➕ Please type the next item.\n\n" +

            "Example: *Milk 2 Ltr*"
        );

        return;
    }

    /* =====================================================
       EDIT
    ===================================================== */

    if (
        buttonId ===
        "EDIT_ITEM"
    ) {

        if (
            session.status !==
            STATES.PREORDER
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        await sendEditMenu(
            phoneNumberId,
            from,
            session
        );

        return;
    }

    /* =====================================================
       CONFIRM
    ===================================================== */

    if (
        buttonId ===
        "GENERATE_FINAL_BILL"
    ) {

        cleanInvalidCartItems(
            session
        );

        if (
            session.status !==
            STATES.PREORDER ||

            !session.cart.length
        ) {

            await sendText(
                phoneNumberId,
                from,

                "🛒 No valid products are available to confirm.\n\n" +

                "Type *Chacha* to start again."
            );

            return;
        }

        await askAddressChoice(
            phoneNumberId,
            from,
            session,
            customerId
        );

        return;
    }

    /* =====================================================
       PREVIOUS ADDRESS
    ===================================================== */

    if (
        buttonId ===
        "USE_PREVIOUS_ADDRESS"
    ) {

        if (
            session.status !==
            STATES.AWAITING_ADDRESS_CHOICE
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        const savedAddress =
            await getAddress(
                customerId
            );

        if (
            !savedAddress
        ) {

            session.status =
                STATES.AWAITING_ADDRESS;

            await sendText(
                phoneNumberId,
                from,

                "📍 Previous address was not found.\n\n" +

                "Please send your current complete address, or share your WhatsApp location pin."
            );

            return;
        }

        try {

            const resolved =
                await prepareSavedAddressForDistance(
                    savedAddress
                );

            const distance =
                await validateDeliveryDistance(
                    resolved
                );

            if (
                !distance.withinRange
            ) {

                session.status =
                    STATES.AWAITING_ADDRESS_CHOICE;

                let msg =
                    `🚫 *Previous address is outside the delivery area.*\n\n` +

                    `📏 Distance: *${distance.distanceKm.toFixed(2)} km*`;

                if (
                    distance.maxDistanceKm != null
                ) {

                    msg +=
                        `\n🚚 Delivery limit: *${distance.maxDistanceKm.toFixed(2)} km*`;
                }

                msg +=
                    "\n\nPlease use your current address.";

                await sendButtons(
                    phoneNumberId,
                    from,
                    msg,
                    [
                        {
                            id:
                                "USE_CURRENT_ADDRESS",

                            title:
                                "📍 Current Address"
                        }
                    ]
                );

                return;
            }

            setSessionAddress(
                session,
                resolved,
                distance
            );

            await sendText(
                phoneNumberId,
                from,

                `✅ Previous address selected.\n` +

                `📏 Distance from store: *${distance.distanceKm.toFixed(2)} km*`
            );

            await sendFinalBill(
                phoneNumberId,
                from,
                session
            );
        }

        catch (
            error
        ) {

            session.status =
                STATES.AWAITING_ADDRESS_CHOICE;

            await sendButtons(
                phoneNumberId,
                from,

                `⚠️ Could not verify the previous address distance.\n\n` +

                `${error.message}\n\n` +

                `Please use your current address.`,

                [
                    {
                        id:
                            "USE_CURRENT_ADDRESS",

                        title:
                            "📍 Current Address"
                    }
                ]
            );
        }

        return;
    }

    /* =====================================================
       CURRENT ADDRESS BUTTON
    ===================================================== */

    if (
        buttonId ===
        "USE_CURRENT_ADDRESS" ||

        buttonId ===
        "ADD_ADDRESS"
    ) {

        if (
            ![
                STATES.AWAITING_ADDRESS_CHOICE,
                STATES.FINAL
            ].includes(
                session.status
            )
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        session.address =
            null;

        session.addressId =
            null;

        session.addressLatitude =
            null;

        session.addressLongitude =
            null;

        session.deliveryDistanceKm =
            null;

        session.status =
            STATES.AWAITING_ADDRESS;

        await sendText(
            phoneNumberId,
            from,

            "📍 *Current Address*\n\n" +

            "Please send your complete current delivery address.\n\n" +

            "You can also share your WhatsApp location pin for a faster distance check."
        );

        return;
    }

    /* =====================================================
       DON'T LET RANDOM TEXT BECOME PRODUCT
       WHILE ADDRESS BUTTONS ARE WAITING
    ===================================================== */

    if (
        session.status ===
        STATES.AWAITING_ADDRESS_CHOICE
    ) {

        await sendText(
            phoneNumberId,
            from,

            "📍 Please choose *Previous Address* or *Current Address* using the buttons above."
        );

        return;
    }

    /* =====================================================
       PAY NOW
    ===================================================== */

    if (
        buttonId ===
        "ADD_PAYMENT"
    ) {

        cleanInvalidCartItems(
            session
        );

        if (
            session.status !==
            STATES.FINAL ||

            !session.cart.length
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This payment button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        await placePendingOrder(
            phoneNumberId,
            from,
            session,
            customerId
        );

        return;
    }

    /* =====================================================
       BACK CART
    ===================================================== */

    if (
        buttonId ===
        "BACK_TO_CART"
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ].includes(
                session.status
            )
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        session.editItemNo =
            null;

        await sendPreOrderBill(
            phoneNumberId,
            from,
            session
        );

        return;
    }

    /* =====================================================
       EDIT QUANTITY
    ===================================================== */

    if (
        buttonId?.startsWith(
            "EDIT_QTY_"
        )
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ].includes(
                session.status
            )
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        const itemNo =
            Number(
                buttonId.replace(
                    "EDIT_QTY_",
                    ""
                )
            );

        const item =
            session.cart.find(
                x =>
                    Number(
                        x.cartId
                    ) ===
                    itemNo
            );

        if (!item) {

            await sendText(
                phoneNumberId,
                from,

                "❌ Product is no longer in the cart."
            );

            return;
        }

        session.editItemNo =
            itemNo;

        session.status =
            STATES.AWAITING_EDIT_DETAILS;

        await sendText(
            phoneNumberId,
            from,

            `✏️ *${item.product_name}*\n` +

            `Current: ${formatQty(item.qty)} ${item.unit}\n\n` +

            `Send the new quantity only.\n` +

            `Examples: *2 kg*, *500 g*, *3 pcs*`
        );

        return;
    }

    /* =====================================================
       REMOVE PRODUCT
    ===================================================== */

    if (
        buttonId?.startsWith(
            "REMOVE_ITEM_"
        )
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ].includes(
                session.status
            )
        ) {

            await sendText(
                phoneNumberId,
                from,

                "This button is no longer active. Type *Chacha* to start again."
            );

            return;
        }

        const itemNo =
            Number(
                buttonId.replace(
                    "REMOVE_ITEM_",
                    ""
                )
            );

        const result =
            removeCartItem(
                session,
                itemNo
            );

        if (
            result.error
        ) {

            await sendText(
                phoneNumberId,
                from,

                `❌ ${result.error}`
            );

            return;
        }

        session.editItemNo =
            null;

        if (
            !session.cart.length
        ) {

            session.status =
                STATES.IDLE;

            await sendText(
                phoneNumberId,
                from,

                `🗑️ ${result.removed.product_name} removed.\n\n` +

                `🛒 Your cart is now empty.`
            );

            return;
        }

        await sendPreOrderBill(
            phoneNumberId,
            from,
            session,

            `🗑️ Removed: ${result.removed.product_name}`
        );

        return;
    }

    /* =====================================================
       EMPTY / MEDIA
    ===================================================== */

    if (
        !text &&

        !(
            session.status ===
            STATES.AWAITING_ADDRESS &&

            location
        )
    ) {

        await sendText(
            phoneNumberId,
            from,

            "Please type the product name and quantity.\n" +

            "Example: *Atta 2 Kg*"
        );

        return;
    }

    const normalized =
        normalizeText(
            text
        );

    /* =====================================================
       CANCEL
    ===================================================== */

    if (
        [
            "cancel",
            "reset",
            "clear cart"
        ].includes(
            normalized
        )
    ) {

        resetConversation(
            session,
            true
        );

        await sendText(
            phoneNumberId,
            from,

            "🗑️ Your current order has been cancelled.\n\n" +

            "Type *Chacha* to start again."
        );

        return;
    }

    /* =====================================================
       VIEW CART
    ===================================================== */

    if (
        [
            "cart",
            "view cart",
            "my cart"
        ].includes(
            normalized
        )
    ) {

        cleanInvalidCartItems(
            session
        );

        if (
            !session.cart.length
        ) {

            await sendText(
                phoneNumberId,
                from,

                "🛒 Your cart is empty."
            );

            return;
        }

        await sendText(
            phoneNumberId,
            from,

            buildBill(
                session.cart,
                "Your Cart"
            ).text
        );

        return;
    }

    /* =====================================================
       ADDRESS INPUT
    ===================================================== */

    if (
        session.status ===
        STATES.AWAITING_ADDRESS
    ) {

        try {

            let addressData =
                null;

            if (
                location
            ) {

                if (
                    !Number.isFinite(
                        location.latitude
                    ) ||

                    !Number.isFinite(
                        location.longitude
                    )
                ) {

                    throw new Error(
                        "Invalid WhatsApp location coordinates."
                    );
                }

                const reverseGeo =
                    await reverseGeocodeCoordinates(
                        location.latitude,
                        location.longitude
                    );

                addressData = {

                    ...reverseGeo,

                    address:
                        location.address ||
                        location.name ||
                        reverseGeo.address,

                    name:
                        location.name ||
                        null
                };
            }

            else {

                const address =
                    String(
                        text || ""
                    ).trim();

                if (
                    address.length < 5
                ) {

                    await sendText(
                        phoneNumberId,
                        from,

                        "📍 Please send a valid complete delivery address, or share your WhatsApp location pin."
                    );

                    return;
                }

                addressData =
                    await geocodeAddress(
                        address
                    );
            }

            const distance =
                await validateDeliveryDistance(
                    addressData
                );

            if (
                !distance.withinRange
            ) {

                let msg =
                    `🚫 *This address is outside the delivery area.*\n\n` +

                    `📏 Distance from store: *${distance.distanceKm.toFixed(2)} km*`;

                if (
                    distance.maxDistanceKm != null
                ) {

                    msg +=
                        `\n🚚 Delivery limit: *${distance.maxDistanceKm.toFixed(2)} km*`;
                }

                msg +=
                    "\n\nPlease send another current address within the delivery area.";

                await sendText(
                    phoneNumberId,
                    from,
                    msg
                );

                return;
            }

            const addressId =
                await saveAddress(
                    customerId,
                    from,
                    addressData
                );

            const saved = {

                ...addressData,

                id:
                    addressId
            };

            setSessionAddress(
                session,
                saved,
                distance
            );

            session.status =
                STATES.FINAL;

            await sendText(
                phoneNumberId,
                from,

                `✅ Current address saved successfully.\n` +

                `📍 ${saved.address}\n` +

                `📏 Distance from store: *${distance.distanceKm.toFixed(2)} km*`
            );

            await sendFinalBill(
                phoneNumberId,
                from,
                session
            );
        }

        catch (
            error
        ) {

            console.error(
                "Address verification error:",
                error.message
            );

            await sendText(
                phoneNumberId,
                from,

                `❌ Could not verify this address.\n\n` +

                `${error.message}\n\n` +

                `Please send a complete address or share your WhatsApp location pin.`
            );
        }

        return;
    }

    /* =====================================================
       EDIT ITEM NUMBER
    ===================================================== */

    if (
        session.status ===
        STATES.AWAITING_EDIT
    ) {

        const itemNo =
            Number(
                normalized
            );

        const item =
            session.cart.find(
                x =>
                    Number(
                        x.cartId
                    ) ===
                    itemNo
            );

        if (!item) {

            await sendText(
                phoneNumberId,
                from,

                "❌ Please enter a valid item number. Example: *1*"
            );

            return;
        }

        session.editItemNo =
            itemNo;

        session.status =
            STATES.AWAITING_EDIT_DETAILS;

        await sendEditAction(
            phoneNumberId,
            from,
            item
        );

        return;
    }

    /* =====================================================
       EDIT DETAILS
    ===================================================== */

    if (
        session.status ===
        STATES.AWAITING_EDIT_DETAILS
    ) {

        await ensureCurrentCatalogLoaded();

        const match =
            normalized.match(
                /^(\d+(?:\.\d+)?)(?:\s+([a-zA-Z.]+))?$/
            );

        if (
            !match ||
            !session.editItemNo
        ) {

            await sendText(
                phoneNumberId,
                from,

                "❌ Send the new quantity like *2 kg*, *500 g* or *3 pcs*."
            );

            return;
        }

        const result =
            editCartItem(
                session,
                session.editItemNo,
                Number(
                    match[1]
                ),
                match[2] ||
                null
            );

        if (
            result.error
        ) {

            await sendText(
                phoneNumberId,
                from,

                `❌ ${result.error}`
            );

            return;
        }

        const itemNo =
            session.editItemNo;

        session.editItemNo =
            null;

        await sendPreOrderBill(
            phoneNumberId,
            from,
            session,

            `✅ Item ${itemNo} updated successfully.`
        );

        return;
    }

    /* =====================================================
       FINAL / PROCESSING
    ===================================================== */

    if (
        session.status ===
        STATES.FINAL
    ) {

        await sendText(
            phoneNumberId,
            from,

            "Please tap *Pay Now* above to continue."
        );

        return;
    }

    if (
        session.status ===
        STATES.PROCESSING
    ) {

        await sendText(
            phoneNumberId,
            from,

            "Your order is being processed."
        );

        return;
    }

    if (
        ![
            STATES.IDLE,
            STATES.AWAITING_MORE,
            STATES.PREORDER
        ].includes(
            session.status
        )
    ) {

        await sendText(
            phoneNumberId,
            from,

            "Please use the available option above, or type *Chacha* to start a new order."
        );

        return;
    }

    /* =====================================================
       ONLY NOW LOAD 28K PRODUCTS
    ===================================================== */

    await ensureCurrentCatalogLoaded();

    /* =====================================================
       BLOCK LINKS
    ===================================================== */

    if (
        /(?:https?:\/\/|www\.)/i.test(
            String(
                text
            ).trim()
        )
    ) {

        await sendText(
            phoneNumberId,
            from,

            "❌ A link cannot be added as a product.\n\n" +

            "Please type the product name and quantity.\n" +

            "Example: *Atta 2 Kg*"
        );

        return;
    }

    /* =====================================================
       PRODUCT PARSING
    ===================================================== */

    const parsed =
        parseOrderText(
            text
        );

    const validItems =
        parsed.filter(
            item =>
                !item.error &&
                isValidCartItem(
                    item
                )
        );

    const invalidItems =
        parsed.filter(
            item =>
                item.error ||
                !isValidCartItem(
                    item
                )
        );

    if (
        !validItems.length
    ) {

        let msg =
            "❌ Product not found with at least 80% confidence.\n\n" +
            "Please type a more complete product name.";

        if (
            invalidItems.length
        ) {

            const reasons =
                invalidItems
                    .map(
                        item =>
                            item.error
                    )
                    .filter(
                        Boolean
                    );

            if (
                reasons.length
            ) {

                msg +=
                    `\n\n${reasons.join("\n")}`;
            }
        }

        msg +=
            "\n\nExample:\n*Whole Wheat Atta 2 Kg*";

        await sendText(
            phoneNumberId,
            from,
            msg
        );

        return;
    }

    const operation =
        addToCart(
            session,
            validItems
        );

    if (
        !session.cart.length
    ) {

        session.status =
            STATES.IDLE;

        await sendText(
            phoneNumberId,
            from,

            "❌ No valid product was added."
        );

        return;
    }

    if (
        invalidItems.length
    ) {

        const reasons =
            invalidItems
                .map(
                    x =>
                        x.error
                )
                .filter(
                    Boolean
                );

        if (
            reasons.length
        ) {

            await sendText(
                phoneNumberId,
                from,

                `⚠️ Some items were not added:\n\n${
                    reasons
                        .map(
                            x =>
                                `• ${x}`
                        )
                        .join("\n")
                }`
            );
        }
    }

    await sendProductImages(
        phoneNumberId,
        from,
        operation.added
    );

    await sendPreOrderBill(
        phoneNumberId,
        from,
        session,

        cartOperationNote(
            operation
        )
    );
}

/* =========================================================
   WEBHOOK POST
========================================================= */

app.post(
    "/webhook",
    async (
        req,
        res
    ) => {

        try {

            if (
                !verifySignature(
                    req
                )
            ) {

                console.warn(
                    "Invalid Meta webhook signature"
                );

                return res.sendStatus(
                    403
                );
            }

            const body =
                req.body;

            if (
                !body ||
                body.object !==
                "whatsapp_business_account"
            ) {

                return res.sendStatus(
                    200
                );
            }

            for (
                const entry
                of body.entry || []
            ) {

                for (
                    const change
                    of entry.changes || []
                ) {

                    const value =
                        change.value || {};

                    for (
                        const status
                        of value.statuses || []
                    ) {

                        try {

                            await updateMessageStatus(
                                status
                            );
                        }

                        catch (
                            error
                        ) {

                            console.error(
                                "Status update warning:",
                                error.message
                            );
                        }
                    }

                    const messages =
                        value.messages || [];

                    if (
                        !messages.length
                    ) {
                        continue;
                    }

                    const phoneNumberId =
                        value.metadata
                            ?.phone_number_id;

                    if (
                        !phoneNumberId
                    ) {

                        console.warn(
                            "metadata.phone_number_id missing"
                        );

                        continue;
                    }

                    const channel =
                        await getMerchantByNumber(
                            phoneNumberId
                        );

                    if (
                        !channel
                    ) {

                        console.warn(
                            `No active approved/test merchant for: ${phoneNumberId}`
                        );

                        continue;
                    }

                    const unseenMessages =
                        [];

                    for (
                        const message
                        of messages
                    ) {

                        try {

                            if (
                                message?.id &&

                                await isMessageAlreadySaved(
                                    message.id
                                )
                            ) {

                                console.log(
                                    `↩️ Duplicate WhatsApp message ignored before catalog load: ${message.id}`
                                );

                                continue;
                            }
                        }

                        catch (
                            error
                        ) {

                            console.error(
                                "Early duplicate check warning:",
                                error.message
                            );
                        }

                        unseenMessages.push(
                            message
                        );
                    }

                    if (
                        !unseenMessages.length
                    ) {
                        continue;
                    }

                    /*
                     * LIGHTWEIGHT CONTEXT:
                     * Product catalog is NOT loaded
                     * just for Hi / random text / Chacha.
                     */

                    const context =
                        createLightweightMerchantContext(
                            channel
                        );

                    await merchantContext.run(
                        context,

                        async () => {

                            for (
                                const message
                                of unseenMessages
                            ) {

                                try {

                                    await handleMessage(
                                        phoneNumberId,
                                        message
                                    );
                                }

                                catch (
                                    error
                                ) {

                                    console.error(
                                        "Message processing error:",
                                        error.response?.data ||
                                        error.message ||
                                        error
                                    );
                                }
                            }
                        }
                    );
                }
            }

            return res.sendStatus(
                200
            );
        }

        catch (
            error
        ) {

            console.error(
                "Webhook error:",
                error.response?.data ||
                error.message ||
                error
            );

            /*
             * Return 200 so Meta does not
             * endlessly retry a bad payload.
             */

            return res.sendStatus(
                200
            );
        }
    }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
    "/",
    async (
        req,
        res
    ) => {

        try {

            await query(
                "SELECT 1"
            );

            res
                .status(200)
                .json({
                    success:
                        true,

                    message:
                        "CODE-Bot WhatsApp server is running",

                    welcome_command:
                        [
                            "Chacha",
                            "chacha"
                        ]
                });
        }

        catch (
            error
        ) {

            res
                .status(500)
                .json({
                    success:
                        false,

                    message:
                        error.message
                });
        }
    }
);

/* =========================================================
   START SERVER
========================================================= */

async function start() {

    try {

        const missingRequiredEnv =
            [];

        if (
            !process.env.DB_USER
        ) {

            missingRequiredEnv.push(
                "DB_USER"
            );
        }

        if (
            !process.env.DB_NAME
        ) {

            missingRequiredEnv.push(
                "DB_NAME"
            );
        }

        if (
            missingRequiredEnv.length
        ) {

            throw new Error(
                `Missing required .env variable(s): ${missingRequiredEnv.join(", ")}. ` +
                `Expected .env beside index.js at ${path.join(__dirname, ".env")}`
            );
        }

        await query(
            "SELECT 1"
        );

        console.log(
            "✅ Database connected"
        );

        console.log(
            `🗄️ Database: ${process.env.DB_USER}@${process.env.DB_HOST || "127.0.0.1"}/${process.env.DB_NAME}`
        );

        if (!TOKEN) {

            console.warn(
                "⚠️ TOKEN missing in .env"
            );
        }

        if (!MYTOKEN) {

            console.warn(
                "⚠️ MYTOKEN missing in .env"
            );
        }

        if (!APP_SECRET) {

            console.warn(
                "⚠️ APP_SECRET not set; webhook signature verification is disabled"
            );
        }

        if (
            !GOOGLE_MAPS_API_KEY
        ) {

            console.warn(
                "⚠️ GOOGLE_MAPS_API_KEY missing. Typed-address distance checking will not work; WhatsApp location pins will still work."
            );
        }

        app.listen(
            PORT,
            () => {

                console.log(
                    `🚀 CODE-Bot webhook running on port ${PORT}`
                );

                console.log(
                    "🤖 Strict welcome gate: Chacha / chacha ONLY"
                );

                console.log(
                    "🏪 Automatic merchant mapping enabled"
                );

                console.log(
                    "📍 Previous / Current address selection enabled"
                );

                console.log(
                    "📏 Merchant delivery-distance checking enabled"
                );
            }
        );
    }

    catch (
        error
    ) {

        console.error(
            "❌ Server startup failed:",
            error.message
        );

        process.exit(
            1
        );
    }
}

start();