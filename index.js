const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
require("dotenv").config();

const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}));

app.use(express.urlencoded({
    extended: true
}));


/* =========================================================
   CONFIG
========================================================= */

const PORT =
    Number(
        process.env.PORT ||
        8000
    );

const TOKEN =
    process.env.TOKEN ||
    "";

const MYTOKEN =
    process.env.MYTOKEN ||
    "";

const APP_SECRET =
    process.env.APP_SECRET ||
    "";

const GRAPH_VERSION =
    process.env.GRAPH_VERSION ||
    "v25.0";


const SESSION_TIMEOUT_MS =
    30 * 60 * 1000;

const CATALOG_CACHE_MS =
    60 * 1000;


const merchantContext =
    new AsyncLocalStorage();

const sessions =
    new Map();

const catalogCache =
    new Map();

const conversationContexts =
    new Map();


/* =========================================================
   DATABASE
========================================================= */

const db =
    mysql.createPool({

        host:
            process.env.DB_HOST ||
            "localhost",

        user:
            process.env.DB_USER ||
            "root",

        password:
            process.env.DB_PASSWORD ||
            "",

        database:
            process.env.DB_NAME ||
            "code_bot_version1.1",

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
   CURRENT MERCHANT CONTEXT
========================================================= */

function merchant() {

    const value =
        merchantContext
            .getStore();

    if (!value) {

        throw new Error(
            "Merchant context missing"
        );
    }

    return value;
}


function currentMerchantId() {

    return (
        merchant()
            .merchantId
    );
}


function currentChannelId() {

    return (
        merchant()
            .channelId
    );
}


function currentShopName() {

    return (
        merchant()
            .shopName
    );
}


function currentProducts() {

    return (
        merchant()
            .products ||
        []
    );
}


function currentUnits() {

    return (
        merchant()
            .units ||
        []
    );
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
   TEXT / UNIT HELPERS
========================================================= */

function normalizeText(
    value
) {

    return String(
        value ||
        ""
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
                    ) ===
                        wanted ||

                    normalizeUnit(
                        u.unit_name
                    ) ===
                        wanted
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
            item.qty ||
            0
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
        dimension ===
            "weight" &&

        unit ===
            "g"
    ) {

        return (
            qty / 1000
        );
    }


    if (
        dimension ===
            "volume" &&

        unit ===
            "ml"
    ) {

        return (
            qty / 1000
        );
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
        !Number.isFinite(
            qty
        ) ||

        qty <= 0
    ) {

        throw new Error(
            "Quantity must be greater than 0."
        );
    }


    if (
        !Number.isFinite(
            price
        ) ||

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
        dimension ===
            "weight" &&

        unit ===
            "g"
    ) {

        billingQty =
            qty / 1000;
    }


    if (
        dimension ===
            "volume" &&

        unit ===
            "ml"
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
            )
                .toFixed(
                    2
                )
        );


    return (
        item.total
    );
}


function formatQty(
    value
) {

    const n =
        Number(
            value
        );


    if (
        !Number.isFinite(
            n
        )
    ) {

        return String(
            value ||
            ""
        );
    }


    if (
        Number.isInteger(
            n
        )
    ) {

        return String(
            n
        );
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

function buildSearchTokens(
    row
) {

    const tokens =
        new Set();


    function add(
        value
    ) {

        const normalized =
            normalizeText(
                value
            );


        if (!normalized) {
            return;
        }


        tokens.add(
            normalized
        );


        normalized
            .split(
                /\s+/
            )
            .forEach(
                word => {

                    if (
                        word.length >=
                        2
                    ) {

                        tokens.add(
                            word
                        );
                    }
                }
            );
    }


    add(
        row.product_name
    );


    add(
        row.brand_name
    );


    add(
        row.category_name
    );


    add(
        row.description
    );


    add(
        row.package_size
    );


    String(
        row.aliases ||
        ""
    )
        .split(
            /[,|;]/
        )
        .map(
            x =>
                x.trim()
        )
        .filter(
            Boolean
        )
        .forEach(
            add
        );


    return [
        ...tokens
    ];
}


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


function findProduct(
    queryText
) {

    const q =
        normalizeText(
            queryText
        );


    if (!q) {

        return null;
    }


    const products =
        currentProducts()
            .filter(
                isUsableProduct
            );


    /*
     * Exact product name.
     */

    let found =
        products.find(
            p =>

                normalizeText(
                    p.product_name
                ) ===
                q
        );


    if (found) {

        return found;
    }


    /*
     * Exact alias/token.
     */

    found =
        products.find(
            p =>

                (
                    p.searchTokens ||
                    []
                )
                    .some(
                        token =>

                            token &&

                            token ===
                            q
                    )
        );


    if (found) {

        return found;
    }


    /*
     * Partial product name.
     *
     * Empty product name is NEVER allowed.
     */

    found =
        products.find(
            p => {

                const name =
                    normalizeText(
                        p.product_name
                    );


                if (!name) {

                    return false;
                }


                return (

                    name.includes(
                        q
                    ) ||

                    q.includes(
                        name
                    )
                );
            }
        );


    if (found) {

        return found;
    }


    /*
     * Token fallback.
     */

    const words =
        q
            .split(
                /\s+/
            )
            .filter(
                word =>
                    word.length >=
                    2
            );


    let best =
        null;


    let bestScore =
        0;


    for (
        const p
        of products
    ) {

        const tokens =
            p.searchTokens ||
            [];


        let score =
            0;


        for (
            const word
            of words
        ) {

            if (
                tokens.includes(
                    word
                )
            ) {

                score++;
            }
        }


        if (
            score >
            bestScore
        ) {

            bestScore =
                score;


            best =
                p;
        }
    }


    return (
        bestScore > 0
            ? best
            : null
    );
}


function parseQuantity(
    text
) {

    const original =
        String(
            text ||
            ""
        )
            .trim();


    const match =
        original.match(

            /(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|ltr|l|lt|litre|litres|liter|liters|ml|pcs|pc|piece|pieces|nos|no|pkt|pk|pkts|packet|pack|packs)?\s*$/i
        );


    if (!match) {

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


function cleanProductText(
    text,
    quantityInfo
) {

    const original =
        String(
            text ||
            ""
        )
            .trim();


    const q =

        quantityInfo ||

        parseQuantity(
            original
        );


    if (
        !q.matchedText
    ) {

        return (
            normalizeText(
                original
            )
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


function parseSingleOrder(
    text
) {

    const original =
        String(
            text ||
            ""
        )
            .trim();


    if (!original) {

        return {

            error:
                "Empty product"
        };
    }


    const exact =
        currentProducts()

            .filter(
                isUsableProduct
            )

            .find(
                p =>

                    normalizeText(
                        p.product_name
                    ) ===

                    normalizeText(
                        original
                    )
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
        normalizeText(
            original
        );


    let product =
        exact ||
        null;


    if (!product) {

        q =
            parseQuantity(
                original
            );


        productText =
            cleanProductText(
                original,
                q
            );


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


    const qty =
        Number(
            q.qty ||
            1
        );


    if (
        !Number.isFinite(
            qty
        ) ||

        qty <= 0
    ) {

        return {

            error:
                `Invalid quantity for ${product.product_name}`
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
            .test(raw);


    const hasVolume =
        /(^|[\/\s])(ml|l|ltr|litre|liter|litres|liters)([\/\s]|$)/i
            .test(raw);


    const hasCount =
        /(piece|pieces|pcs|packet|pack|pkt|set|pair|count|nos|number)/i
            .test(raw);


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
            )
                .trim(),

        unit_price:
            Number(
                product.selling_price
            ),

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


function parseOrderText(
    text
) {

    return String(
        text ||
        ""
    )
        .split(
            /[,;\n]+/
        )
        .map(
            x =>
                x.trim()
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

                cart:
                    [],

                address:
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
            session.lastActivity ||
            0
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


    session.status =
        STATES.IDLE;


    session.cart =
        [];


    session.address =
        address;


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
        session.cart ||
        []
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
        ) > 0
    );
}


function cleanInvalidCartItems(
    session
) {

    session.cart =
        (
            session.cart ||
            []
        )
            .filter(
                isValidCartItem
            );


    renumberCart(
        session
    );


    return (
        session.cart
    );
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
            ) ===
                "g"

                ? Number(
                    existing.qty
                ) / 1000

                : Number(
                    existing.qty
                );


        const b =

            normalizeUnit(
                incoming.unit
            ) ===
                "g"

                ? Number(
                    incoming.qty
                ) / 1000

                : Number(
                    incoming.qty
                );


        existing.qty =
            Number(
                (
                    a +
                    b
                )
                    .toFixed(
                        4
                    )
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
            ) ===
                "ml"

                ? Number(
                    existing.qty
                ) / 1000

                : Number(
                    existing.qty
                );


        const b =

            normalizeUnit(
                incoming.unit
            ) ===
                "ml"

                ? Number(
                    incoming.qty
                ) / 1000

                : Number(
                    incoming.qty
                );


        existing.qty =
            Number(
                (
                    a +
                    b
                )
                    .toFixed(
                        4
                    )
            );


        existing.unit =
            "ltr";
    }


    else {

        const a =

            normalizeUnit(
                existing.unit
            ) ||

            "pcs";


        const b =

            normalizeUnit(
                incoming.unit
            ) ||

            "pcs";


        if (
            a !==
            b
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

        ok:
            true,

        item:
            existing
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

        added:
            [],

        merged:
            [],

        errors:
            []
    };


    for (
        const item
        of items ||
        []
    ) {

        if (
            !isValidCartItem(
                item
            )
        ) {

            result.errors
                .push(

                    item?.error ||

                    "Invalid product was not added."
                );


            continue;
        }


        const existing =
            session.cart
                .find(
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

                result.errors
                    .push(
                        merged.error
                    );
            }

            else {

                result.merged
                    .push(
                        existing
                    );
            }
        }

        else {

            session.cart
                .push({

                    ...item
                });


            result.added
                .push(
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

    const lines =
        [];


    if (
        operation.added
            ?.length
    ) {

        lines.push(

            `➕ Added: ${

                operation.added
                    .map(
                        x =>
                            x.product_name
                    )
                    .join(
                        ", "
                    )
            }`
        );
    }


    if (
        operation.merged
            ?.length
    ) {

        lines.push(

            `🔄 Quantity increased: ${

                operation.merged
                    .map(
                        x =>
                            x.product_name
                    )
                    .join(
                        ", "
                    )
            }`
        );
    }


    if (
        operation.errors
            ?.length
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


function buildBill(
    items,
    title
) {

    const valid =
        (
            items ||
            []
        )
            .filter(
                isValidCartItem
            );


    const lines = [

        `🧾 *${title}*`,

        "```",

        "No  Product             Qty   Unit   Price",

        "----------------------------------------------------"
    ];


    let total =
        0;


    valid.forEach(
        (
            item,
            index
        ) => {

            const name =
                String(
                    item.product_name
                )
                    .padEnd(
                        20
                    )
                    .slice(
                        0,
                        20
                    );


            const qty =
                formatQty(
                    item.qty
                )
                    .padEnd(
                        5
                    );


            const unit =
                String(
                    item.unit ||
                    ""
                )
                    .padEnd(
                        6
                    );


            const price =
                Number(
                    item.total ||
                    0
                )
                    .toFixed(
                        2
                    );


            lines.push(

                `${

                    String(
                        index +
                        1
                    )
                        .padEnd(
                            3
                        )

                } ${name} ${qty} ${unit} ${price}`
            );


            total +=
                Number(
                    item.total ||
                    0
                );
        }
    );


    lines.push(
        "---------------------------------------------------"
    );


    lines.push(

        `Total: ₹ ${

            total.toFixed(
                2
            )
        }`
    );


    lines.push(
        "```"
    );


    return {

        text:
            lines.join(
                "\n"
            ),

        total:
            Number(
                total.toFixed(
                    2
                )
            )
    };
}


function removeCartItem(
    session,
    itemNo
) {

    const index =
        session.cart
            .findIndex(
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
        session.cart
            .splice(
                index,
                1
            );


    renumberCart(
        session
    );


    return {

        ok:
            true,

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
        session.cart
            .find(
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
        !Number.isFinite(
            n
        ) ||

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
        d1 !==
        d2
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

        ok:
            true,

        item
    };
}


/* =========================================================
   MERCHANT / PRODUCT CATALOG
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

              AND p.status =
                  'active'

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

            WHERE status =
                  'active'

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


/* =========================================================
   CUSTOMER / CONVERSATION / MESSAGE DB
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

        return (
            rows[0]
                .customer_id
        );
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


        return (
            result.insertId
        );
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

            return (
                rows[0]
                    .customer_id
            );
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

              AND status =
                  'open'

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


    return (
        result.insertId
    );
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

            message.text
                ?.body ||

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


    return "";
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


    /*
     * external_message_id is UNIQUE.
     *
     * INSERT IGNORE means:
     *
     * New Meta message:
     * affectedRows = 1
     *
     * Duplicate/retry:
     * affectedRows = 0
     */

    const result =
        await query(
            `
            INSERT IGNORE
            INTO cb_messages
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
                    message ||
                    {}
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
            result.affectedRows ||
            0
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
                payload ||
                {}
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
            status?.status ||
            ""
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

            state ===
                "delivered"

                ? when
                : null,

            state ===
                "read"

                ? when
                : null,

            state ===
                "failed"

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
   WHATSAPP SEND
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
            context
                ?.conversationId
        ) {

            await saveOutboundMessage(

                context
                    .conversationId,

                response,

                payload.type ||
                "text",

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
                    )
                        .slice(
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


function sendButtons(
    phoneNumberId,
    to,
    text,
    buttons
) {

    const safeButtons =
        (
            buttons ||
            []
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
                            )
                                .slice(
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
                        )
                            .slice(
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
                city,
                state,
                pincode

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


async function saveAddress(
    customerId,
    from,
    address
) {

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
                is_default
            )

            VALUES
            (
                ?,
                ?,
                ?,
                1
            )
            `,
            [
                customerId,
                from,
                address
            ]
        );


    return (
        result.insertId
    );
}


/* =========================================================
   DISPLAY FLOW
========================================================= */

function welcomeMessage() {

    return (

        `🌾🌟 *Welcome!* to *${currentShopName()}* 🌟🌾\n` +

        `• Powered by *CODE Bot*\n\n` +

        `🛒 Thank you for choosing us for your everyday needs.\n\n` +

        `📥 *How to Order*\n` +

        `• Type: *<Product Name> <Quantity Unit>*\n` +

        `• Example: *Whole Wheat Atta 5 Kg*\n\n` +

        `• You can also type just the product name.\n` +

        `• Multiple items: use comma.\n\n` +

        `🔢 *Units*: kg, g, pcs, ml, ltr, pkt`
    );
}


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


    await sendButtons(

        phoneNumberId,

        from,

        body,

        [
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
        ]
    );


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


    session.cart
        .forEach(
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

            "❌ No valid product is available to generate the final bill.\n\n" +

            "Type *Chacha* to start again."
        );


        return;
    }


    const bill =
        buildBill(
            session.cart,
            "Final Bill"
        );


    const savedAddress =
        await getAddress(
            customerId
        );


    if (
        !session.address &&
        savedAddress
    ) {

        session.address =
            savedAddress.address;
    }


    let body =

        `🏪 *${currentShopName()}*\n\n${bill.text}`;


    if (
        session.address
    ) {

        body +=

            `\n📍 *Delivery Address:*\n${session.address}\n\n` +

            `🚚 We'll deliver ASAP.`;


        await sendButtons(

            phoneNumberId,

            from,

            body,

            [
                {
                    id:
                        "ADD_PAYMENT",

                    title:
                        "💳 Pay Now"
                }
            ]
        );
    }

    else {

        body +=

            "\n⚠️ No address found.\n" +

            "Please add your delivery address first.";


        await sendButtons(

            phoneNumberId,

            from,

            body,

            [
                {
                    id:
                        "ADD_ADDRESS",

                    title:
                        "📍 Add Address"
                }
            ]
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
        bill.total <=
        0
    ) {

        throw new Error(
            "Invalid order total."
        );
    }


    const connection =
        await db
            .getConnection();


    try {

        await connection
            .beginTransaction();


        const statusId =
            await getPendingStatusId(
                connection
            );


        const orderNumber =

            `ORD${Date.now()}${

                Math.floor(
                    Math.random() *
                    10000
                )
                    .toString()
                    .padStart(
                        4,
                        "0"
                    )
            }`;


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
                ) ===
                    ""
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


        const [addressRows] =
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
                    bill.total *
                    100
                )
            ]
        );


        await connection
            .commit();


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

        await connection
            .rollback();


        throw error;
    }

    finally {

        connection
            .release();
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
        !session.address
    ) {

        const saved =
            await getAddress(
                customerId
            );


        if (saved) {

            session.address =
                saved.address;
        }
    }


    if (
        !session.address
    ) {

        session.status =
            STATES.AWAITING_ADDRESS;


        await sendText(

            phoneNumberId,

            from,

            "📍 Please send your complete delivery address."
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
            ) ||
            ""
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
   VERIFY WEBHOOK
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


        return res
            .sendStatus(
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
            message.from ||
            ""
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


    if (
        message.type ===
        "text"
    ) {

        text =
            String(

                message.text
                    ?.body ||

                ""
            )
                .trim();
    }


    else if (
        message.type ===
        "interactive"
    ) {

        if (
            message
                .interactive
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
            message
                .interactive
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


        /*
         * DB logging failure should not
         * completely stop the bot.
         */

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
       WELCOME

       ONLY:
       Chacha
       chacha

       Nothing else.
    ===================================================== */

    if (
        !buttonId &&

        (
            text ===
                "Chacha" ||

            text ===
                "chacha"
        )
    ) {

        /*
         * Start clean order.
         *
         * Old cart is removed.
         * Address may remain.
         */

        resetConversation(
            session,
            true
        );


        await sendText(

            phoneNumberId,

            from,

            welcomeMessage()
        );


        return;
    }


    /* =====================================================
       COMPLETED ORDER

       OLD BUTTONS / OLD MESSAGES
       CANNOT REOPEN ORDER.
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
       ADD MORE ITEMS BUTTON
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

                "This button is no longer active. " +

                "Type *Chacha* to start again."
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
       EDIT ITEM BUTTON
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

                "This button is no longer active. " +

                "Type *Chacha* to start again."
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
       CONFIRM BUTTON
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


        await sendFinalBill(

            phoneNumberId,

            from,

            session,

            customerId
        );


        return;
    }


    /* =====================================================
       ADD ADDRESS BUTTON
    ===================================================== */

    if (
        buttonId ===
        "ADD_ADDRESS"
    ) {

        if (
            session.status !==
            STATES.FINAL
        ) {

            await sendText(

                phoneNumberId,

                from,

                "This button is no longer active. " +

                "Type *Chacha* to start again."
            );


            return;
        }


        session.status =
            STATES.AWAITING_ADDRESS;


        await sendText(

            phoneNumberId,

            from,

            "📍 Please send your complete delivery address."
        );


        return;
    }


    /* =====================================================
       PAY NOW BUTTON
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

                "This payment button is no longer active. " +

                "Type *Chacha* to start again."
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
       BACK TO CART
    ===================================================== */

    if (
        buttonId ===
        "BACK_TO_CART"
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ]
                .includes(
                    session.status
                )
        ) {

            await sendText(

                phoneNumberId,

                from,

                "This button is no longer active. " +

                "Type *Chacha* to start again."
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
       EDIT QUANTITY BUTTON
    ===================================================== */

    if (
        buttonId
            ?.startsWith(
                "EDIT_QTY_"
            )
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ]
                .includes(
                    session.status
                )
        ) {

            await sendText(

                phoneNumberId,

                from,

                "This button is no longer active. " +

                "Type *Chacha* to start again."
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
            session.cart
                .find(
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
       REMOVE ITEM BUTTON
    ===================================================== */

    if (
        buttonId
            ?.startsWith(
                "REMOVE_ITEM_"
            )
    ) {

        if (
            ![
                STATES.AWAITING_EDIT,
                STATES.AWAITING_EDIT_DETAILS
            ]
                .includes(
                    session.status
                )
        ) {

            await sendText(

                phoneNumberId,

                from,

                "This button is no longer active. " +

                "Type *Chacha* to start again."
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
       EMPTY / UNSUPPORTED MESSAGE
    ===================================================== */

    if (!text) {

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
        ]
            .includes(
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
        ]
            .includes(
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
            )
                .text
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

        const address =
            String(
                text
            )
                .trim();


        if (
            address.length <
            5
        ) {

            await sendText(

                phoneNumberId,

                from,

                "📍 Please send a valid complete delivery address."
            );


            return;
        }


        await saveAddress(

            customerId,

            from,

            address
        );


        session.address =
            address;


        session.status =
            STATES.FINAL;


        await sendText(

            phoneNumberId,

            from,

            "✅ Address saved successfully."
        );


        await sendFinalBill(

            phoneNumberId,

            from,

            session,

            customerId
        );


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
            session.cart
                .find(
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

                "❌ Please enter a valid item number. " +

                "Example: *1*"
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
       EDIT QUANTITY TEXT
    ===================================================== */

    if (
        session.status ===
        STATES.AWAITING_EDIT_DETAILS
    ) {

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

                "❌ Send the new quantity like " +

                "*2 kg*, *500 g* or *3 pcs*."
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
       FINAL STATE
    ===================================================== */

    if (
        session.status ===
        STATES.FINAL
    ) {

        await sendText(

            phoneNumberId,

            from,

            "Please tap *Pay Now* or *Add Address* above."
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


    /* =====================================================
       ADD PRODUCT
       IDLE / MORE / PREORDER
    ===================================================== */

    const parsed =
        parseOrderText(
            text
        );


    const validItems =
        parsed
            .filter(
                item =>

                    !item.error &&

                    isValidCartItem(
                        item
                    )
            );


    const invalidItems =
        parsed
            .filter(
                item =>

                    item.error ||

                    !isValidCartItem(
                        item
                    )
            );


    /*
     * CRITICAL:
     *
     * No valid product =
     * NO CART
     * NO BILL
     */

    if (
        !validItems.length
    ) {

        let message =
            "❌ Product not found.";


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

                message +=

                    `\n\n${

                        reasons.join(
                            "\n"
                        )
                    }`;
            }
        }


        message +=

            "\n\nExample:\n" +

            "*Atta 2 Kg*";


        await sendText(

            phoneNumberId,

            from,

            message
        );


        return;
    }


    const operation =
        addToCart(

            session,

            validItems
        );


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
                        .join(
                            "\n"
                        )

                }`
            );
        }
    }


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


                return res
                    .sendStatus(
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

                return res
                    .sendStatus(
                        200
                    );
            }


            for (
                const entry
                of body.entry ||
                []
            ) {

                for (
                    const change
                    of entry.changes ||
                    []
                ) {

                    const value =
                        change.value ||
                        {};


                    /*
                     * DELIVERY / READ / FAILED STATUS
                     */

                    for (
                        const status
                        of value.statuses ||
                        []
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
                        value.messages ||
                        [];


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


                    /*
                     * AUTOMATIC MERCHANT MAPPING
                     */

                    const channel =
                        await getMerchantByNumber(
                            phoneNumberId
                        );


                    if (!channel) {

                        console.warn(

                            `No active approved/test merchant for: ${phoneNumberId}`
                        );


                        continue;
                    }


                    /*
                     * LOAD ONLY THIS MERCHANT'S PRODUCTS
                     */

                    const context =
                        await loadMerchantCatalog(
                            channel
                        );


                    await merchantContext.run(

                        context,

                        async () => {

                            for (
                                const message
                                of messages
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


            return res
                .sendStatus(
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
             * repeatedly send the same
             * webhook forever.
             */

            return res
                .sendStatus(
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

                    welcome_command: [
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
   START
========================================================= */

async function start() {

    try {

        await query(
            "SELECT 1"
        );


        console.log(
            "✅ Database connected"
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


        app.listen(

            PORT,

            () => {

                console.log(

                    `🚀 CODE-Bot webhook running on port ${PORT}`
                );


                console.log(

                    "🤖 Welcome command: Chacha / chacha ONLY"
                );


                console.log(

                    "🏪 Automatic merchant mapping enabled"
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