const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   ENVIRONMENT
========================================================= */

const PORT = process.env.PORT || 8000;

const TOKEN = process.env.TOKEN;
const MYTOKEN = process.env.MYTOKEN;

const SHOP_NAME = "RamDev Baba Kirana";

const DEFAULT_VENDOR_ID = 2;

const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

/* =========================================================
   DATABASE
========================================================= */

const db = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "code_bot_version_1",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function dbQuery(sql, params = []) {
    const [rows] = await db.execute(sql, params);
    return rows;
}

/* =========================================================
   STATES
========================================================= */

const STATES = {
    IDLE: "IDLE",
    PREORDER: "PREORDER",
    AWAITING_MORE: "AWAITING_MORE",
    AWAITING_EDIT: "AWAITING_EDIT",
    AWAITING_EDIT_DETAILS: "AWAITING_EDIT_DETAILS",
    AWAITING_ADDRESS: "AWAITING_ADDRESS",
    FINAL: "FINAL",
    COMPLETED: "COMPLETED"
};

/* =========================================================
   MEMORY
========================================================= */

const sessions = new Map();

let productCatalog = [];
let unitCatalog = [];

/* =========================================================
   NORMALIZE TEXT
========================================================= */

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[^\w\s.-]/g, " ")
        .replace(/\s+/g, " ");
}

/* =========================================================
   UNIT HELPERS
========================================================= */

const UNIT_ALIASES = {
    kg: "kg",
    kgs: "kg",
    kilo: "kg",
    kilos: "kg",

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

function normalizeUnit(unit) {
    if (!unit) return null;

    const key = normalizeText(unit);

    return UNIT_ALIASES[key] || key;
}

function convertToKg(qty, unit) {
    const value = Number(qty) || 0;
    const normalized = normalizeUnit(unit);

    switch (normalized) {
        case "g":
            return value / 1000;

        case "kg":
            return value;

        default:
            return value;
    }
}

function convertToLitre(qty, unit) {
    const value = Number(qty) || 0;
    const normalized = normalizeUnit(unit);

    switch (normalized) {
        case "ml":
            return value / 1000;

        case "ltr":
            return value;

        default:
            return value;
    }
}

function isCountUnit(unit) {
    const normalized = normalizeUnit(unit);

    return [
        "pcs",
        "pkt"
    ].includes(normalized);
}


/* =========================================================
   PRODUCT / UNIT TYPE HELPERS
========================================================= */

function getUnitDimension(unit) {
    const normalized = normalizeUnit(unit);

    if (["kg", "g"].includes(normalized)) {
        return "weight";
    }

    if (["ltr", "ml"].includes(normalized)) {
        return "volume";
    }

    if (isCountUnit(normalized)) {
        return "count";
    }

    return null;
}

function detectProductUnitType(product, requestedUnit = null) {
    const requestedDimension = getUnitDimension(requestedUnit);

    if (requestedDimension) {
        return requestedDimension;
    }

    const raw = normalizeText(product?.unit_type || "");
    const stockUnit = normalizeUnit(product?.stock_unit);
    const stockDimension = getUnitDimension(stockUnit);

    if (stockDimension) {
        return stockDimension;
    }

    // Values in master_products are commonly "g/kg", "ml/l", "pieces", etc.
    const hasWeight = /(^|[\/\s])(g|kg|gram|grams|kilogram|kilograms)([\/\s]|$)/i.test(raw);
    const hasVolume = /(^|[\/\s])(ml|l|ltr|litre|liter|litres|liters)([\/\s]|$)/i.test(raw);
    const hasCount = /(piece|pieces|pcs|packet|pack|pkt|set|pair|count|nos|number)/i.test(raw);

    if (hasCount) return "count";
    if (hasWeight && !hasVolume) return "weight";
    if (hasVolume && !hasWeight) return "volume";

    // Ambiguous values such as "ml/g" represent packaged products.
    // When the customer does not specify a unit, treat one package as one piece.
    return "count";
}

function getDefaultUnitForType(unitType) {
    if (unitType === "weight") return "kg";
    if (unitType === "volume") return "ltr";
    return "pcs";
}

function findUnitId(unit) {
    const normalized = normalizeUnit(unit);

    const match = (unitCatalog || []).find(row => {
        return (
            normalizeUnit(row.short_name) === normalized ||
            normalizeUnit(row.unit_name) === normalized
        );
    });

    return match ? match.unit_id : null;
}

function calculateItemTotal(item) {
    const qty = Number(item.qty);

    if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Quantity must be greater than 0.");
    }

    const unitType = item.unit_type || detectProductUnitType(item, item.unit);
    const unit = normalizeUnit(item.unit) || getDefaultUnitForType(unitType);
    const price = Number(item.unit_price ?? item.selling_price ?? 0);

    item.unit_type = unitType;
    item.unit = unit;
    item.unit_id = findUnitId(unit) || item.unit_id || null;

    if (unitType === "weight") {
        const qtyInKg = convertToKg(qty, unit);
        item.qtyInKg = Number(qtyInKg.toFixed(4));
        item.total = Number((price * qtyInKg).toFixed(2));
        return item.total;
    }

    if (unitType === "volume") {
        const qtyInLitre = convertToLitre(qty, unit);
        item.qtyInLitre = Number(qtyInLitre.toFixed(4));
        item.total = Number((price * qtyInLitre).toFixed(2));
        return item.total;
    }

    item.total = Number((price * qty).toFixed(2));
    return item.total;
}

/* =========================================================
   FORMAT QUANTITY
========================================================= */

function formatQty(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return String(value || "");
    }

    if (Number.isInteger(number)) {
        return String(number);
    }

    return number
        .toFixed(3)
        .replace(/0+$/, "")
        .replace(/\.$/, "");
}

/* =========================================================
   SEARCH TOKENS
========================================================= */

function buildSearchTokens(row) {
    const tokens = new Set();

    const addValue = value => {
        if (!value) return;

        const normalized = normalizeText(value);

        if (!normalized) return;

        tokens.add(normalized);

        normalized
            .split(/\s+/)
            .forEach(token => {
                if (token.length >= 2) {
                    tokens.add(token);
                }
            });
    };

    addValue(row.product_name);
    addValue(row.brand_name);
    addValue(row.category_name);
    addValue(row.description);
    addValue(row.package_size);

    if (row.aliases) {
        String(row.aliases)
            .split(/[,|;]/)
            .forEach(alias => {
                addValue(alias);
            });
    }

    return [...tokens];
}

/* =========================================================
   PRODUCT MATCH
========================================================= */

function findProduct(query) {
    const normalizedQuery = normalizeText(query);

    if (!normalizedQuery) {
        return null;
    }

    /* Exact product name */
    let match = productCatalog.find(product => {
        return normalizeText(product.product_name) === normalizedQuery;
    });

    if (match) {
        return match;
    }

    /* Exact alias/token */
    match = productCatalog.find(product => {
        return (product.searchTokens || [])
            .some(token => token === normalizedQuery);
    });

    if (match) {
        return match;
    }

    /* Product name contains query */
    match = productCatalog.find(product => {
        const name =
            normalizeText(product.product_name);

        return (
            name.includes(normalizedQuery) ||
            normalizedQuery.includes(name)
        );
    });

    if (match) {
        return match;
    }

    /* Token based search */
    const words = normalizedQuery.split(/\s+/);

    let best = null;
    let bestScore = 0;

    for (const product of productCatalog) {
        const tokens = product.searchTokens || [];

        let score = 0;

        for (const word of words) {
            if (tokens.includes(word)) {
                score++;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            best = product;
        }
    }

    return best;
}

/* =========================================================
   PARSE QUANTITY
========================================================= */

function parseQuantity(text) {
    const original = String(text || "").trim();

    // Quantity is accepted only at the END of the order item.
    // This prevents product names like "1200W Hair Dryer" or "2 in 1 Trimmer"
    // from being interpreted as quantities.
    const match = original.match(
        /(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|ltr|l|lt|litre|litres|liter|liters|ml|pcs|pc|piece|pieces|nos|no|pkt|pk|pkts|packet|pack|packs)?\s*$/i
    );

    if (!match) {
        return {
            qty: 1,
            unit: null,
            matchedText: ""
        };
    }

    return {
        qty: Number(match[1]),
        unit: normalizeUnit(match[2]),
        matchedText: match[0]
    };
}

/* =========================================================
   REMOVE QUANTITY FROM PRODUCT TEXT
========================================================= */

function cleanProductText(text, quantityInfo = null) {
    const original = String(text || "").trim();
    const quantity = quantityInfo || parseQuantity(original);

    if (!quantity.matchedText) {
        return normalizeText(original);
    }

    return normalizeText(
        original.slice(0, original.length - quantity.matchedText.length)
    );
}

/* =========================================================
   PARSE SINGLE ORDER
========================================================= */

function parseSingleOrder(text) {
    const original = String(text || "").trim();

    if (!original) {
        return {
            error: "Empty product"
        };
    }

    // If the whole text exactly matches a product name, do NOT remove
    // trailing numbers from the product name. Example: a model ending in "2".
    const exactWholeProduct = productCatalog.find(product => {
        return normalizeText(product.product_name) === normalizeText(original);
    });

    let quantity = {
        qty: 1,
        unit: null,
        matchedText: ""
    };

    let productText = normalizeText(original);
    let product = exactWholeProduct || null;

    if (!product) {
        quantity = parseQuantity(original);
        productText = cleanProductText(original, quantity);
        product = findProduct(productText);
    }

    if (!product) {
        return {
            error: `Product not found: ${productText || original}`,
            requestedText: original
        };
    }

    const qty = Number(quantity.qty || 1);

    if (!Number.isFinite(qty) || qty <= 0) {
        return {
            error: `Invalid quantity for ${product.product_name}`,
            requestedText: original
        };
    }

    let unit = quantity.unit;
    const unitType = detectProductUnitType(product, unit);

    if (!unit) {
        unit = getDefaultUnitForType(unitType);
    }

    const requestedDimension = getUnitDimension(unit);

    // For non-ambiguous products, reject incompatible user units.
    const rawType = normalizeText(product.unit_type || "");
    const rawHasWeight = /(^|[\/\s])(g|kg|gram|grams|kilogram|kilograms)([\/\s]|$)/i.test(rawType);
    const rawHasVolume = /(^|[\/\s])(ml|l|ltr|litre|liter|litres|liters)([\/\s]|$)/i.test(rawType);
    const rawHasCount = /(piece|pieces|pcs|packet|pack|pkt|set|pair|count|nos|number)/i.test(rawType);

    if (requestedDimension === "weight" && rawHasVolume && !rawHasWeight && !rawHasCount) {
        return { error: `${product.product_name} uses a volume unit such as ml/ltr.` };
    }

    if (requestedDimension === "volume" && rawHasWeight && !rawHasVolume && !rawHasCount) {
        return { error: `${product.product_name} uses a weight unit such as g/kg.` };
    }

    if (requestedDimension !== "count" && rawHasCount && !rawHasWeight && !rawHasVolume) {
        return { error: `${product.product_name} is sold by piece/packet.` };
    }

    const item = {
        ...product,
        product_name: product.product_name,
        unit_price: Number(product.selling_price || 0),
        qty,
        unit: normalizeUnit(unit),
        unit_type: unitType,
        vendor_product_id: product.vendor_product_id,
        unit_id: findUnitId(unit) || product.unit_id || null
    };

    try {
        calculateItemTotal(item);
    }
    catch (error) {
        return {
            error: error.message,
            requestedText: original
        };
    }

    return item;
}

/* =========================================================
   PARSE MULTIPLE ORDER ITEMS
========================================================= */

function parseOrderText(text) {
    const parts =
        String(text || "")
            .split(/[,;\n]+/)
            .map(item => item.trim())
            .filter(Boolean);

    if (parts.length === 0) {
        return [];
    }

    return parts.map(parseSingleOrder);
}

/* =========================================================
   SESSION
========================================================= */

function getSession(phoneNumber) {
    if (!sessions.has(phoneNumber)) {
        sessions.set(phoneNumber, {
            status: STATES.IDLE,
            cart: [],
            address: null,
            orderId: null,
            orderNumber: null,
            orderTotal: null,
            pendingItems: null,
            lastSummary: null,
            editItemNo: null,
            paymentProcessing: false,
            expired: false,
            lastActivity: Date.now()
        });
    }

    const session =
        sessions.get(phoneNumber);

    const now = Date.now();

    if (
        session.lastActivity &&
        now - session.lastActivity >
            SESSION_TIMEOUT_MS
    ) {
        session.cart = [];
        session.pendingItems = null;
        session.lastSummary = null;
        session.orderId = null;
        session.orderNumber = null;
        session.orderTotal = null;
        session.editItemNo = null;
        session.paymentProcessing = false;
        session.status = STATES.IDLE;
        session.expired = true;
    }

    session.lastActivity = now;

    return session;
}

/* =========================================================
   UPDATE SESSION ACTIVITY
========================================================= */

function touchSession(session) {
    session.lastActivity = Date.now();
    session.expired = false;
}

/* =========================================================
   ADD TO CART
========================================================= */

function renumberCart(session) {
    (session.cart || []).forEach((item, index) => {
        item.cartId = index + 1;
    });
}

function mergeSameProduct(existing, incoming) {
    const dimension = existing.unit_type || detectProductUnitType(existing, existing.unit);
    const incomingDimension = incoming.unit_type || detectProductUnitType(incoming, incoming.unit);

    if (dimension !== incomingDimension) {
        return {
            error: `Please use a compatible unit for ${incoming.product_name}.`
        };
    }

    if (dimension === "weight") {
        const totalKg =
            convertToKg(existing.qty, existing.unit) +
            convertToKg(incoming.qty, incoming.unit);

        existing.qty = Number(totalKg.toFixed(4));
        existing.unit = "kg";
        existing.unit_id = findUnitId("kg") || existing.unit_id || null;
    }
    else if (dimension === "volume") {
        const totalLitre =
            convertToLitre(existing.qty, existing.unit) +
            convertToLitre(incoming.qty, incoming.unit);

        existing.qty = Number(totalLitre.toFixed(4));
        existing.unit = "ltr";
        existing.unit_id = findUnitId("ltr") || existing.unit_id || null;
    }
    else {
        const existingUnit = normalizeUnit(existing.unit) || "pcs";
        const incomingUnit = normalizeUnit(incoming.unit) || "pcs";

        if (existingUnit !== incomingUnit) {
            return {
                error:
                    `Please use the same unit for ${incoming.product_name}. ` +
                    `Current unit is ${existingUnit}.`
            };
        }

        existing.qty =
            Number(existing.qty || 0) +
            Number(incoming.qty || 0);

        existing.unit = existingUnit;
        existing.unit_id = findUnitId(existingUnit) || existing.unit_id || null;
    }

    calculateItemTotal(existing);

    return {
        ok: true,
        item: existing
    };
}

function addToCart(session, items) {
    if (!Array.isArray(session.cart)) {
        session.cart = [];
    }

    const operation = {
        added: [],
        merged: [],
        errors: []
    };

    for (const item of items || []) {
        if (!item || item.error) {
            continue;
        }

        const existing = session.cart.find(cartItem => {
            return Number(cartItem.vendor_product_id) === Number(item.vendor_product_id);
        });

        if (existing) {
            const snapshot = { ...existing };
            const merged = mergeSameProduct(existing, item);

            if (merged.error) {
                Object.assign(existing, snapshot);
                operation.errors.push(merged.error);
            }
            else {
                operation.merged.push(existing);
            }

            continue;
        }

        const newItem = {
            ...item,
            cartId: session.cart.length + 1
        };

        session.cart.push(newItem);
        operation.added.push(newItem);
    }

    renumberCart(session);

    return operation;
}

function buildCartOperationNote(operation) {
    const lines = [];

    if (operation?.added?.length) {
        lines.push(
            `➕ Added: ${operation.added.map(item => item.product_name).join(", ")}`
        );
    }

    if (operation?.merged?.length) {
        lines.push(
            `🔄 Quantity increased: ${operation.merged.map(item => item.product_name).join(", ")}`
        );
    }

    if (operation?.errors?.length) {
        lines.push(
            `⚠️ ${operation.errors.join("\n⚠️ ")}`
        );
    }

    return lines.join("\n");
}

/* =========================================================
   BUILD SUMMARY - WHATSAPP / MOBILE FRIENDLY
========================================================= */

function buildTabularSummary(
    items,
    heading = "Bill"
) {
    const lines = [];

    lines.push(
        `🧾 *${heading}*`
    );

    lines.push("```");

    lines.push(
        "No  Product             Qty   Unit   Price"
    );

    lines.push(
        "----------------------------------------------------"
    );

    let total = 0;

    (items || []).forEach(
        (item, index) => {
            if (!item || item.error) {
                return;
            }

            const name =
                String(
                    item.product_name || ""
                )
                    .padEnd(20)
                    .slice(0, 20);

            const qty =
                formatQty(item.qty)
                    .padEnd(5);

            const unit =
                String(item.unit || "")
                    .padEnd(6);

            const price =
                Number(item.total || 0)
                    .toFixed(2);

            lines.push(
                `${String(index + 1).padEnd(3)} ${name} ${qty} ${unit} ${price}`
            );

            total +=
                Number(item.total || 0);
        }
    );

    lines.push(
        "---------------------------------------------------"
    );

    lines.push(
        `Total: ₹ ${total.toFixed(2)}`
    );

    lines.push("```");

    return {
        text: lines.join("\n"),
        grandTotal:
            Number(total.toFixed(2))
    };
}

/* =========================================================
   VIEW CART
========================================================= */

function viewCartSummary(session) {
    const items = session.cart || [];

    if (items.length === 0) {
        return "🛒 Your cart is empty.";
    }

    return buildTabularSummary(
        items,
        "Your Cart"
    ).text;
}

/* =========================================================
   EDIT CART ITEM
========================================================= */

function editCartItem(
    session,
    itemNo,
    newQty,
    newUnit
) {
    const item = (session.cart || []).find(
        cartItem => cartItem.cartId === itemNo
    );

    if (!item) {
        return {
            error: "Item number not found in cart."
        };
    }

    const qty = Number(newQty);

    if (!Number.isFinite(qty) || qty <= 0) {
        return {
            error: "Quantity must be greater than 0. Use Remove Product to delete the item."
        };
    }

    const nextUnit = normalizeUnit(newUnit) || item.unit;
    const nextDimension = getUnitDimension(nextUnit);
    const currentDimension = item.unit_type || detectProductUnitType(item, item.unit);

    if (
        nextDimension &&
        currentDimension &&
        nextDimension !== currentDimension
    ) {
        return {
            error: `Please use a ${currentDimension} unit for ${item.product_name}.`
        };
    }

    const snapshot = { ...item };

    item.qty = qty;
    item.unit = nextUnit;
    item.unit_id = findUnitId(nextUnit) || item.unit_id || null;

    try {
        calculateItemTotal(item);
    }
    catch (error) {
        Object.assign(item, snapshot);
        return { error: error.message };
    }

    return {
        ok: true,
        item
    };
}

/* =========================================================
   REMOVE CART ITEM
========================================================= */

function removeCartItem(
    session,
    itemNo
) {
    const index = (session.cart || []).findIndex(
        item => item.cartId === itemNo
    );

    if (index === -1) {
        return {
            error: "Item number not found in cart."
        };
    }

    const [removed] = session.cart.splice(index, 1);

    renumberCart(session);

    return {
        ok: true,
        removed
    };
}

/* =========================================================
   RESET CONVERSATION
========================================================= */

function resetConversation(
    session,
    keepAddress = true
) {
    const savedAddress =
        session.address;

    session.pendingItems = null;
    session.lastSummary = null;
    session.cart = [];
    session.status = STATES.IDLE;
    session.orderId = null;
    session.orderNumber = null;
    session.orderTotal = null;
    session.expired = false;
    session.editItemNo = null;
    session.paymentProcessing = false;
    session.lastActivity = Date.now();

    session.address =
        keepAddress
            ? savedAddress
            : null;
}
/* =========================================================
   CUSTOMER
========================================================= */

async function ensureCustomerExists(userNumber) {
    const rows = await dbQuery(
        `
        SELECT customer_id
        FROM customers
        WHERE whatsapp_number = ?
        LIMIT 1
        `,
        [userNumber]
    );

    if (rows.length > 0) {
        return rows[0].customer_id;
    }

    const result = await dbQuery(
        `
        INSERT INTO customers
        (
            whatsapp_number
        )
        VALUES (?)
        `,
        [userNumber]
    );

    return result.insertId;
}

/* =========================================================
   GET USER ADDRESS
========================================================= */

async function getUserAddress(userNumber) {
    try {
        const rows = await dbQuery(
            `
            SELECT address
            FROM customer_address
            WHERE user_number = ?
            ORDER BY is_default DESC, id DESC
            LIMIT 1
            `,
            [userNumber]
        );

        if (rows.length > 0) {
            return rows[0].address;
        }
    }
    catch (error) {
        /*
         * Some installations may not have the exact
         * customer_address structure. Continue to
         * customers.default_address in that case.
         */
        console.error(
            "Address lookup warning:",
            error.message
        );
    }

    try {
        const customerRows =
            await dbQuery(
                `
                SELECT default_address
                FROM customers
                WHERE whatsapp_number = ?
                LIMIT 1
                `,
                [userNumber]
            );

        if (customerRows.length > 0) {
            return (
                customerRows[0]
                    .default_address ||
                null
            );
        }
    }
    catch (error) {
        console.error(
            "Customer address lookup warning:",
            error.message
        );
    }

    return null;
}

/* =========================================================
   LOAD CATALOGS
========================================================= */

async function loadCatalogs() {
    try {

        /*
         * PRODUCTS
         */

        const productRows =
            await dbQuery(
                `
                SELECT
                    vp.vendor_product_id,
                    vp.vendor_id,
                    vp.product_id,
                    vp.selling_price,
                    vp.stock_quantity,
                    vp.stock_unit,
                    vp.unit_id,

                    mp.product_id AS master_product_id,
                    mp.product_name,
                    mp.brand_name,
                    mp.category_name,
                    mp.unit_type,
                    mp.package_size,
                    mp.aliases,
                    mp.description

                FROM vendor_products vp

                INNER JOIN master_products mp
                    ON mp.product_id =
                       vp.product_id

                WHERE vp.vendor_id = ?
                  AND vp.is_available = 1
                  AND vp.is_deleted = 0
                  AND mp.status = 'active'

                ORDER BY mp.product_name ASC
                `,
                [DEFAULT_VENDOR_ID]
            );

        productCatalog =
            productRows.map(row => ({
                ...row,

                searchTokens:
                    buildSearchTokens(row),

                selling_price:
                    Number(
                        row.selling_price || 0
                    ),

                unit_id:
                    row.unit_id ?? null,

                vendor_product_id:
                    row.vendor_product_id
            }));

        /*
         * UNITS
         */

        try {
            const unitRows =
                await dbQuery(
                    `
                    SELECT
                        unit_id,
                        unit_name,
                        short_name,
                        unit_type
                    FROM units
                    WHERE status = 'active'
                       OR status IS NULL
                    `
                );

            unitCatalog =
                unitRows.map(row => ({
                    ...row,

                    unit_name_norm:
                        normalizeText(
                            row.unit_name
                        ),

                    short_name_norm:
                        normalizeText(
                            row.short_name
                        ),

                    unit_type_norm:
                        normalizeText(
                            row.unit_type
                        )
                }));
        }
        catch (unitError) {
            console.error(
                "⚠️ Unit loading warning:",
                unitError.message
            );

            unitCatalog = [];
        }

        console.log(
            `✅ Loaded ${productCatalog.length} products for vendor ${DEFAULT_VENDOR_ID}`
        );

        console.log(
            `✅ Loaded ${unitCatalog.length} units`
        );
    }
    catch (error) {
        console.error(
            "❌ Catalog Load Error:",
            error.message
        );

        throw error;
    }
}

/* =========================================================
   WHATSAPP SEND TEXT
========================================================= */

async function sendTextMessage(
    phoneNoId,
    to,
    body
) {
    if (!TOKEN) {
        throw new Error(
            "TOKEN is missing in .env"
        );
    }

    return axios({
        method: "POST",

        url:
            `https://graph.facebook.com/v18.0/${phoneNoId}/messages`,

        headers: {
            Authorization:
                `Bearer ${TOKEN}`,

            "Content-Type":
                "application/json"
        },

        data: {
            messaging_product:
                "whatsapp",

            to,

            type: "text",

            text: {
                body:
                    String(body || "")
            }
        }
    });
}


/* =========================================================
   WHATSAPP SEND LONG TEXT
========================================================= */

async function sendLongTextMessage(phoneNoId, to, body) {
    const text = String(body || "");
    const maxLength = 3500;

    if (text.length <= maxLength) {
        return sendTextMessage(phoneNoId, to, text);
    }

    let remaining = text;

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf("\n", maxLength);

        if (splitAt < 1000) {
            splitAt = maxLength;
        }

        const chunk = remaining.slice(0, splitAt).trim();
        remaining = remaining.slice(splitAt).trim();

        if (chunk) {
            await sendTextMessage(phoneNoId, to, chunk);
        }
    }

    if (remaining) {
        await sendTextMessage(phoneNoId, to, remaining);
    }
}

/* =========================================================
   WHATSAPP BUTTON MESSAGE
========================================================= */

async function sendButtonMessage(
    phoneNoId,
    to,
    body,
    buttons
) {
    if (!TOKEN) {
        throw new Error(
            "TOKEN is missing in .env"
        );
    }

    const safeButtons =
        (buttons || [])
            .slice(0, 3)
            .map(button => ({
                type: "reply",

                reply: {
                    id:
                        String(
                            button.id
                        ),

                    title:
                        String(
                            button.title
                        )
                }
            }));

    return axios({
        method: "POST",

        url:
            `https://graph.facebook.com/v18.0/${phoneNoId}/messages`,

        headers: {
            Authorization:
                `Bearer ${TOKEN}`,

            "Content-Type":
                "application/json"
        },

        data: {
            messaging_product:
                "whatsapp",

            to,

            type: "interactive",

            interactive: {
                type: "button",

                body: {
                    text:
                        String(body || "")
                },

                action: {
                    buttons:
                        safeButtons
                }
            }
        }
    });
}

/* =========================================================
   WELCOME MESSAGE
========================================================= */

function getWelcomeMessage() {
    return (
        `🌾🌟 *Welcome!* to *${SHOP_NAME}* 📍 *New Delhi* 🌟🌾\n` +
        `• Powered by *CODE Bot*\n\n` +

        `🛒 Thank you for choosing us for your everyday needs.\n\n` +

        `📥 *How to Order*\n` +

        `• Type: *<Product Name> <Quantity Unit>*\n` +
        `• Example: *Whole Wheat Atta 5 Kg*\n\n` +

        `• You can also type just the product name:\n` +
        `  *Milk*, *Atta*, *Sugar* → bot assumes 1 unit\n\n` +

        `• Multiple items: use comma\n` +
        `  Example: *Atta 2 Kg, Besan 500 g, Milk 1 Ltr*\n\n` +

        `🔢 *Units*: kg, kgs, g, gm, gms, pcs, pc, no, nos, ml, ltr, l, pkt, pack`
    );
}

/* =========================================================
   UNAVAILABLE PRODUCT
========================================================= */

async function sendUnavailableMessage(
    phoneNoId,
    from
) {
    await sendButtonMessage(
        phoneNoId,
        from,

        "❌ Product not available.\n" +
        "Please search for another product.",

        [
            {
                id:
                    "ADD_OTHER_ITEMS",

                title:
                    "➕ Add Other Items"
            }
        ]
    );
}

/* =========================================================
   PRE-ORDER BILL
========================================================= */

async function sendPreOrderBill(
    phoneNoId,
    from,
    session,
    note = ""
) {
    if (
        !session.cart ||
        session.cart.length === 0
    ) {
        await sendTextMessage(
            phoneNoId,
            from,
            "🛒 Your cart is empty."
        );

        session.status =
            STATES.IDLE;

        return;
    }

    const summary =
        buildTabularSummary(
            session.cart,
            "Pre Order Bill"
        );

    let body =
        `🏪 *${SHOP_NAME}*\n\n`;

    if (note) {
        body +=
            `${note}\n\n`;
    }

    body += summary.text;

    await sendButtonMessage(
        phoneNoId,
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

    session.lastSummary =
        summary;
}

/* =========================================================
   EDIT ITEM OPTIONS
========================================================= */

async function sendEditItemOptions(
    phoneNoId,
    from,
    session
) {
    if (
        !session.cart ||
        session.cart.length === 0
    ) {
        await sendTextMessage(
            phoneNoId,
            from,
            "🛒 Your cart is empty. Please add an item first."
        );

        session.status =
            STATES.IDLE;

        return;
    }

    let message =
        "✏️ *Edit Item*\n\n";

    message +=
        "Please type the item number you want to edit.\n\n";

    session.cart.forEach(item => {
        message +=
            `${item.cartId}. ${item.product_name} - ${formatQty(item.qty)} ${item.unit}\n`;
    });

    message +=
        "\nExample: *1*";

    await sendTextMessage(
        phoneNoId,
        from,
        message
    );

    session.status =
        STATES.AWAITING_EDIT;
}

/* =========================================================
   EDIT INSTRUCTIONS
========================================================= */

async function sendEditInstructions(
    phoneNoId,
    from,
    item
) {
    await sendButtonMessage(
        phoneNoId,
        from,
        `✏️ Editing item ${item.cartId}\n\n` +
        `Product: *${item.product_name}*\n` +
        `Current Quantity: *${formatQty(item.qty)} ${item.unit}*\n\n` +
        `Choose what you want to do:`,
        [
            {
                id: `EDIT_QTY_${item.cartId}`,
                title: "✏️ Edit Quantity"
            },
            {
                id: `REMOVE_ITEM_${item.cartId}`,
                title: "🗑️ Remove Product"
            },
            {
                id: "BACK_TO_CART",
                title: "↩️ Back to Cart"
            }
        ]
    );
}

/* =========================================================
   FINAL BILL
========================================================= */

async function sendFinalBill(
    phoneNoId,
    from,
    session
) {
    if (
        !session.cart ||
        session.cart.length === 0
    ) {
        await sendTextMessage(
            phoneNoId,
            from,
            "🛒 Your cart is empty."
        );

        return;
    }

    const summary =
        buildTabularSummary(
            session.cart,
            "Final Bill"
        );

    const savedAddress =
        session.address ||
        await getUserAddress(from);

    let body =
        `🏪 *${SHOP_NAME}*\n\n` +
        summary.text;

    let buttons = [];

    if (savedAddress) {

        session.address =
            savedAddress;

        body +=
            `\n📍 *Delivery Address:*\n` +
            `${savedAddress}\n\n` +
            `🚚 We'll deliver ASAP.`;

        buttons = [
            {
                id:
                    "ADD_PAYMENT",

                title:
                    "💳 Pay Now"
            }
        ];
    }
    else {

        body +=
            `\n⚠️ No address found.\n` +
            `Please add your delivery address first.`;

        buttons = [
            {
                id:
                    "ADD_ADDRESS",

                title:
                    "📍 Add Address"
            }
        ];
    }

    await sendButtonMessage(
        phoneNoId,
        from,
        body,
        buttons
    );

    session.status =
        STATES.FINAL;

    session.lastSummary =
        summary;
}

/* =========================================================
   GET ORDER STATUS ID
========================================================= */

async function getStatusIdByCode(code) {
    try {
        const rows =
            await dbQuery(
                `
                SELECT status_id
                FROM order_status
                WHERE status_code = ?
                LIMIT 1
                `,
                [code]
            );

        if (rows.length > 0) {
            return rows[0].status_id;
        }
    }
    catch (error) {
        console.error(
            "Order status lookup warning:",
            error.message
        );
    }

    return null;
}

/* =========================================================
   SAVE FINAL ORDER
========================================================= */

async function saveFinalOrder(
    session,
    from,
    customerId
) {
    const bill =
        buildTabularSummary(
            session.cart,
            "Final Bill"
        );

    const orderTime =
        new Date();

    const confirmedStatusId =
        await getStatusIdByCode(
            "pending"
        );

    const orderNumber =
        "ORD" +

        new Date()
            .toISOString()
            .slice(0, 10)
            .replace(/-/g, "") +

        String(Date.now())
            .slice(-6);

    const orderResult =
        await dbQuery(
            `
            INSERT INTO orders
            (
                order_number,
                customer_id,
                vendor_id,
                total_amount,
                payment_status,
                order_time,
                status_id,
                remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                orderNumber,

                customerId,

                DEFAULT_VENDOR_ID,

                bill.grandTotal,

                "pending",

                orderTime,

                confirmedStatusId,

                "WhatsApp bot order"
            ]
        );

    const orderId =
        orderResult.insertId;

    /*
     * SAVE ORDER ITEMS
     */

    for (
        const item
        of session.cart
    ) {

        await dbQuery(
            `
            INSERT INTO order_transaction
            (
                order_id,
                vendor_product_id,
                qty,
                unit_id,
                unit_price,
                total_price,
                remarks,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `,
            [
                orderId,

                item.vendor_product_id,

                item.qty,

                item.unit_id ||
                    null,

                item.unit_price,

                item.total,

                item.product_name
            ]
        );
    }

    return {
        orderId,

        orderNumber,

        totalAmount:
            bill.grandTotal
    };
}

/* =========================================================
   COMPLETE PAYMENT
========================================================= */

async function completePayment(
    phoneNoId,
    from,
    session,
    customerId
) {
    if (
        !session.cart ||
        session.cart.length === 0
    ) {
        await sendTextMessage(
            phoneNoId,
            from,
            "🛒 Your cart is empty."
        );

        return;
    }

    const address =
        session.address ||
        await getUserAddress(from);

    if (!address) {

        await sendTextMessage(
            phoneNoId,
            from,
            "⚠️ Please add your delivery address first."
        );

        session.status =
            STATES.AWAITING_ADDRESS;

        return;
    }

    session.address =
        address;

    /*
     * SAVE ORDER
     */

    const saved =
        await saveFinalOrder(
            session,
            from,
            customerId
        );

    session.orderId =
        saved.orderId;

    /*
     * SAVE PAYMENT
     */

    await dbQuery(
        `
        INSERT INTO payment_transactions
        (
            order_id,
            customer_id,
            payment_reference,
            payment_method,
            total_amount,
            payment_status,
            paid_at,
            remarks
        )
        VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
        `,
        [
            saved.orderId,

            customerId,

            null,

            "manual",

            saved.totalAmount,

            "paid",

            "Payment completed from WhatsApp bot"
        ]
    );

    /*
     * SUCCESS MESSAGE
     */

    await sendTextMessage(
        phoneNoId,
        from,

        `✅ *Order Confirmed!*\n\n` +

        `🧾 Order No: *${saved.orderNumber}*\n` +

        `💰 Total: *₹${saved.totalAmount.toFixed(2)}*\n\n` +

        `📍 Delivery Address:\n${address}\n\n` +

        `🚚 Your order will be delivered ASAP.\n\n` +

        `Thank you for shopping with *${SHOP_NAME}* ❤️`
    );

    session.status =
        STATES.COMPLETED;
}

/* =========================================================
   SAVE ADDRESS
========================================================= */

async function saveUserAddress(
    customerId,
    from,
    address
) {
    /*
     * Try normal INSERT first.
     */

    try {

        await dbQuery(
            `
            INSERT INTO customer_address
            (
                customer_id,
                user_number,
                address
            )
            VALUES (?, ?, ?)
            `,
            [
                customerId,
                from,
                address
            ]
        );

    }
    catch (error) {

        console.error(
            "Customer address insert warning:",
            error.message
        );

        /*
         * If the table has a unique key and
         * duplicate data occurs, update it.
         */

        try {

            await dbQuery(
                `
                UPDATE customer_address
                SET address = ?
                WHERE user_number = ?
                ORDER BY id DESC
                LIMIT 1
                `,
                [
                    address,
                    from
                ]
            );

        }
        catch (updateError) {

            console.error(
                "Customer address update warning:",
                updateError.message
            );
        }
    }

    /*
     * Update customer's default address.
     */

    try {

        await dbQuery(
            `
            UPDATE customers
            SET default_address = ?
            WHERE customer_id = ?
            `,
            [
                address,
                customerId
            ]
        );

    }
    catch (error) {

        console.error(
            "Default address update warning:",
            error.message
        );
    }
}

/* =========================================================
   PARSE EDIT COMMAND
========================================================= */

function parseEditCommand(text) {
    const normalized =
        normalizeText(text);

    /*
     * edit 1 remove
     */

    const removeMatch =
        normalized.match(
            /^edit\s+(\d+)\s+remove$/i
        );

    if (removeMatch) {
        return {
            type: "remove",

            itemNo:
                parseInt(
                    removeMatch[1],
                    10
                )
        };
    }

    /*
     * edit 1 qty 2 kg
     */

    const qtyMatch =
        normalized.match(
            /^edit\s+(\d+)\s+qty\s+(\d+(?:\.\d+)?)(?:\s+([a-zA-Z.]+))?$/i
        );

    if (qtyMatch) {
        return {
            type: "quantity",

            itemNo:
                parseInt(
                    qtyMatch[1],
                    10
                ),

            qty:
                parseFloat(
                    qtyMatch[2]
                ),

            unit:
                qtyMatch[3]
                    ? normalizeUnit(
                        qtyMatch[3]
                    )
                    : null
        };
    }

    return null;
}

/* =========================================================
   BUTTON ID NORMALIZATION
========================================================= */

function normalizeButtonId(value) {
    return String(value || "")
        .trim()
        .toUpperCase();
}

/* =========================================================
   START OF WEBHOOK
========================================================= */

app.get(
    "/webhook",
    (req, res) => {

        const mode =
            req.query["hub.mode"];

        const token =
            req.query["hub.verify_token"];

        const challenge =
            req.query["hub.challenge"];

        if (
            mode === "subscribe" &&
            token === MYTOKEN
        ) {
            console.log(
                "✅ WhatsApp webhook verified"
            );

            return res
                .status(200)
                .send(challenge);
        }

        console.error(
            "❌ WhatsApp webhook verification failed"
        );

        return res
            .sendStatus(403);
    }
);

/* =========================================================
   WEBHOOK POST
========================================================= */

app.post(
    "/webhook",
    async (req, res) => {

        try {

            const body =
                req.body;

            if (
                !body ||
                body.object !== "whatsapp_business_account"
            ) {
                return res.sendStatus(200);
            }

            const entries =
                body.entry || [];

            for (
                const entry
                of entries
            ) {

                const changes =
                    entry.changes || [];

                for (
                    const change
                    of changes
                ) {

                    const value =
                        change.value || {};

                    const messages =
                        value.messages || [];

                    if (
                        messages.length === 0
                    ) {
                        continue;
                    }

                    const phoneNumberId =
                        value.metadata?.phone_number_id;

                    for (
                        const message
                        of messages
                    ) {

                        const from =
                            message.from;

                        if (!from) {
                            continue;
                        }

                        const session =
                            getSession(from);

                        touchSession(
                            session
                        );

                        /*
                         * MESSAGE TEXT
                         */

                        let incomingText =
                            "";

                        if (
                            message.type === "text"
                        ) {
                            incomingText =
                                String(
                                    message.text?.body ||
                                    ""
                                ).trim();
                        }

                        /*
                         * BUTTON RESPONSE
                         */

                        let buttonId =
                            null;

                        if (
                            message.type ===
                            "interactive"
                        ) {

                            if (
                                message.interactive?.type ===
                                "button_reply"
                            ) {
                                buttonId =
                                    normalizeButtonId(
                                        message
                                            .interactive
                                            .button_reply
                                            .id
                                    );

                                incomingText =
                                    message
                                        .interactive
                                        .button_reply
                                        .title ||
                                    "";
                            }

                            else if (
                                message.interactive?.type ===
                                "list_reply"
                            ) {
                                buttonId =
                                    normalizeButtonId(
                                        message
                                            .interactive
                                            .list_reply
                                            .id
                                    );

                                incomingText =
                                    message
                                        .interactive
                                        .list_reply
                                        .title ||
                                    "";
                            }
                        }

                        incomingText =
                            String(
                                incomingText || ""
                            ).trim();

                        const normalizedText =
                            normalizeText(
                                incomingText
                            );

                        const customerId =
                            await ensureCustomerExists(
                                from
                            );

                        /*
                         * BUTTON FLOWS
                         */

                        if (buttonId) {

                            /*
                             * EDIT ACTION BUTTONS
                             */

                            if (buttonId === "BACK_TO_CART") {
                                session.editItemNo = null;

                                await sendPreOrderBill(
                                    phoneNumberId,
                                    from,
                                    session
                                );

                                continue;
                            }

                            if (buttonId.startsWith("EDIT_QTY_")) {
                                const itemNo = parseInt(
                                    buttonId.replace("EDIT_QTY_", ""),
                                    10
                                );

                                const item = (session.cart || []).find(
                                    cartItem => cartItem.cartId === itemNo
                                );

                                if (!item) {
                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        "❌ Product is no longer in the cart."
                                    );

                                    continue;
                                }

                                session.editItemNo = itemNo;
                                session.status = STATES.AWAITING_EDIT_DETAILS;

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,
                                    `✏️ *${item.product_name}*\n` +
                                    `Current: ${formatQty(item.qty)} ${item.unit}\n\n` +
                                    `Send the new quantity only.\n` +
                                    `Examples: *2 kg*, *500 g*, *3 pcs*`
                                );

                                continue;
                            }

                            if (buttonId.startsWith("REMOVE_ITEM_")) {
                                const itemNo = parseInt(
                                    buttonId.replace("REMOVE_ITEM_", ""),
                                    10
                                );

                                const result = removeCartItem(
                                    session,
                                    itemNo
                                );

                                session.editItemNo = null;

                                if (result.error) {
                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `❌ ${result.error}`
                                    );

                                    continue;
                                }

                                if (session.cart.length === 0) {
                                    session.status = STATES.IDLE;

                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `🗑️ ${result.removed.product_name} removed.\n\n` +
                                        `🛒 Your cart is now empty.`
                                    );
                                }
                                else {
                                    await sendPreOrderBill(
                                        phoneNumberId,
                                        from,
                                        session,
                                        `🗑️ Removed: ${result.removed.product_name}`
                                    );
                                }

                                continue;
                            }

                            if (
                                buttonId ===
                                "ADD_OTHER_ITEMS"
                            ) {

                                session.status =
                                    STATES.AWAITING_MORE;

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    "➕ Please type the product you want to add.\n\n" +
                                    "Example: *Sugar 2 Kg*"
                                );

                                continue;
                            }

                            if (
                                buttonId ===
                                "ADD_MORE_ITEMS"
                            ) {

                                session.status =
                                    STATES.AWAITING_MORE;

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    "➕ Please type the next item.\n\n" +
                                    "Example: *Milk 2 Ltr*"
                                );

                                continue;
                            }

                            if (
                                buttonId ===
                                "EDIT_ITEM"
                            ) {

                                await sendEditItemOptions(
                                    phoneNumberId,
                                    from,
                                    session
                                );

                                continue;
                            }

                            if (
                                buttonId ===
                                "GENERATE_FINAL_BILL"
                            ) {

                                await sendFinalBill(
                                    phoneNumberId,
                                    from,
                                    session
                                );

                                continue;
                            }

                            if (
                                buttonId ===
                                "ADD_ADDRESS"
                            ) {

                                session.status =
                                    STATES.AWAITING_ADDRESS;

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    "📍 Please send your complete delivery address."
                                );

                                continue;
                            }

                            if (
                                buttonId ===
                                "ADD_PAYMENT"
                            ) {

                                await completePayment(
                                    phoneNumberId,
                                    from,
                                    session,
                                    customerId
                                );

                                continue;
                            }
                        }

                        /*
                         * EMPTY TEXT
                         */

                        if (!incomingText) {
                            continue;
                        }

                        /*
                         * HI / HELLO / START
                         */

                        if (
                            [
                                "hi",
                                "hii",
                                "hello",
                                "hey",
                                "start",
                                "menu",
                                "chacha",
                                "Chacha"
                            ].includes(
                                normalizedText
                            )
                        ) {

                            if (
                                session.status ===
                                STATES.COMPLETED
                            ) {
                                resetConversation(
                                    session,
                                    true
                                );
                            }

                            await sendTextMessage(
                                phoneNumberId,
                                from,
                                getWelcomeMessage()
                            );

                            session.status =
                                STATES.IDLE;

                            continue;
                        }

                        /*
                         * CANCEL
                         */

                        if (
                            [
                                "cancel",
                                "reset",
                                "clear cart"
                            ].includes(
                                normalizedText
                            )
                        ) {

                            resetConversation(
                                session,
                                true
                            );

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "🗑️ Your current order has been cancelled.\n\n" +
                                "Type *Hi* to start again."
                            );

                            continue;
                        }

                        /*
                         * VIEW CART
                         */

                        if (
                            [
                                "cart",
                                "view cart",
                                "my cart"
                            ].includes(
                                normalizedText
                            )
                        ) {

                            await sendLongTextMessage(
                                phoneNumberId,
                                from,
                                viewCartSummary(
                                    session
                                )
                            );

                            continue;
                        }

                        /*
                         * AWAITING EDIT ITEM NUMBER
                         */

                        if (
                            session.status ===
                            STATES.AWAITING_EDIT
                        ) {

                            const itemNo =
                                parseInt(
                                    normalizedText,
                                    10
                                );

                            if (
                                Number.isInteger(
                                    itemNo
                                ) &&
                                itemNo >= 1 &&
                                itemNo <=
                                    session.cart.length
                            ) {

                                const item =
                                    session.cart[
                                        itemNo - 1
                                    ];

                                session.editItemNo =
                                    itemNo;

                                session.status =
                                    STATES.AWAITING_EDIT_DETAILS;

                                await sendEditInstructions(
                                    phoneNumberId,
                                    from,
                                    item
                                );

                                continue;
                            }

                            /*
                             * Allow direct edit command.
                             */

                            const directEdit =
                                parseEditCommand(
                                    incomingText
                                );

                            if (directEdit) {

                                if (
                                    directEdit.type ===
                                    "remove"
                                ) {

                                    const result =
                                        removeCartItem(
                                            session,
                                            directEdit.itemNo
                                        );

                                    if (
                                        result.error
                                    ) {
                                        await sendTextMessage(
                                            phoneNumberId,
                                            from,
                                            `❌ ${result.error}`
                                        );

                                        continue;
                                    }

                                    await sendPreOrderBill(
                                        phoneNumberId,
                                        from,
                                        session,
                                        `🗑️ Removed: ${result.removed?.product_name || `Item ${directEdit.itemNo}`}`
                                    );

                                    continue;
                                }

                                const result =
                                    editCartItem(
                                        session,
                                        directEdit.itemNo,
                                        directEdit.qty,
                                        directEdit.unit
                                    );

                                if (
                                    result.error
                                ) {
                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `❌ ${result.error}`
                                    );

                                    continue;
                                }

                                await sendPreOrderBill(
                                    phoneNumberId,
                                    from,
                                    session,
                                    `✅ Item ${directEdit.itemNo} updated successfully.`
                                );

                                continue;
                            }

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "❌ Please enter a valid item number.\n\n" +
                                "Example: *1*"
                            );

                            continue;
                        }

                        /*
                         * AWAITING EDIT DETAILS
                         */

                        if (
                            session.status ===
                            STATES.AWAITING_EDIT_DETAILS
                        ) {

                            const editCommand =
                                parseEditCommand(
                                    incomingText
                                );

                            /*
                             * REMOVE
                             */

                            if (
                                editCommand &&
                                editCommand.type ===
                                "remove"
                            ) {

                                const result =
                                    removeCartItem(
                                        session,
                                        editCommand.itemNo
                                    );

                                if (
                                    result.error
                                ) {

                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `❌ ${result.error}`
                                    );

                                    continue;
                                }

                                session.editItemNo =
                                    null;

                                if (
                                    session.cart.length ===
                                    0
                                ) {

                                    session.status =
                                        STATES.IDLE;

                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,

                                        "🛒 Cart is now empty.\n\n" +
                                        "Please type a product to start a new order."
                                    );
                                }
                                else {

                                    await sendPreOrderBill(
                                        phoneNumberId,
                                        from,
                                        session,
                                        `🗑️ Removed: ${result.removed?.product_name || `Item ${editCommand.itemNo}`}`
                                    );
                                }

                                continue;
                            }

                            /*
                             * QUANTITY UPDATE
                             */

                            if (
                                editCommand &&
                                editCommand.type ===
                                "quantity"
                            ) {

                                const result =
                                    editCartItem(
                                        session,
                                        editCommand.itemNo,
                                        editCommand.qty,
                                        editCommand.unit
                                    );

                                if (
                                    result.error
                                ) {

                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `❌ ${result.error}`
                                    );

                                    continue;
                                }

                                session.editItemNo =
                                    null;

                                await sendPreOrderBill(
                                    phoneNumberId,
                                    from,
                                    session,

                                    `✅ Item ${editCommand.itemNo} updated successfully.`
                                );

                                continue;
                            }

                            /*
                             * SIMPLE:
                             *
                             * 2 kg
                             *
                             * when item was already selected.
                             */

                            const simpleQtyMatch =
                                normalizedText.match(
                                    /^(\d+(?:\.\d+)?)(?:\s+([a-zA-Z.]+))?$/i
                                );

                            if (
                                simpleQtyMatch &&
                                session.editItemNo
                            ) {

                                const itemNo =
                                    session.editItemNo;

                                const newQty =
                                    parseFloat(
                                        simpleQtyMatch[1]
                                    );

                                const newUnit =
                                    simpleQtyMatch[2]
                                        ? normalizeUnit(
                                            simpleQtyMatch[2]
                                        )
                                        : null;

                                const result =
                                    editCartItem(
                                        session,
                                        itemNo,
                                        newQty,
                                        newUnit
                                    );

                                if (
                                    result.error
                                ) {

                                    await sendTextMessage(
                                        phoneNumberId,
                                        from,
                                        `❌ ${result.error}`
                                    );

                                    continue;
                                }

                                session.editItemNo =
                                    null;

                                await sendPreOrderBill(
                                    phoneNumberId,
                                    from,
                                    session,

                                    `✅ Item ${itemNo} updated successfully.`
                                );

                                continue;
                            }

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "❌ Invalid edit format.\n\n" +
                                "Use:\n" +
                                "*edit 1 qty 2 kg*\n\n" +
                                "or:\n" +
                                "*edit 1 remove*\n\n" +
                                "You can also type:\n" +
                                "*2 kg*"
                            );

                            continue;
                        }

                        /*
                         * AWAITING ADDRESS
                         */

                        if (
                            session.status ===
                            STATES.AWAITING_ADDRESS
                        ) {

                            const address =
                                incomingText.trim();

                            if (!address) {

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    "📍 Please send a valid delivery address."
                                );

                                continue;
                            }

                            await saveUserAddress(
                                customerId,
                                from,
                                address
                            );

                            session.address =
                                address;

                            session.status =
                                STATES.FINAL;

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "✅ Address saved successfully."
                            );

                            await sendFinalBill(
                                phoneNumberId,
                                from,
                                session
                            );

                            continue;
                        }

                        /*
                         * AWAITING MORE ITEMS
                         */

                        if (
                            session.status ===
                            STATES.AWAITING_MORE
                        ) {

                            const parsed =
                                parseOrderText(
                                    incomingText
                                );

                            const validItems =
                                parsed.filter(
                                    item =>
                                        !item.error
                                );

                            const invalidItems =
                                parsed.filter(
                                    item =>
                                        item.error
                                );

                            if (
                                validItems.length ===
                                0
                            ) {

                                let message =
                                    "❌ I could not find that product.";

                                if (
                                    invalidItems.length
                                ) {
                                    message +=
                                        `\n\n${invalidItems.map(i => i.error).join("\n")}`;
                                }

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,
                                    message
                                );

                                continue;
                            }

                            const cartOperation =
                                addToCart(
                                    session,
                                    validItems
                                );

                            if (
                                invalidItems.length
                            ) {

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    `⚠️ Some items were not found:\n\n` +
                                    invalidItems
                                        .map(
                                            i =>
                                                `• ${i.error}`
                                        )
                                        .join("\n")
                                );
                            }

                            await sendPreOrderBill(
                                phoneNumberId,
                                from,
                                session,
                                buildCartOperationNote(cartOperation)
                            );

                            continue;
                        }

                        /*
                         * PREORDER
                         */

                        if (
                            session.status ===
                            STATES.PREORDER
                        ) {

                            /*
                             * Direct "more"
                             */

                            if (
                                [
                                    "more",
                                    "add more",
                                    "more item",
                                    "add item"
                                ].includes(
                                    normalizedText
                                )
                            ) {

                                session.status =
                                    STATES.AWAITING_MORE;

                                await sendTextMessage(
                                    phoneNumberId,
                                    from,

                                    "➕ Please type the item you want to add."
                                );

                                continue;
                            }

                            /*
                             * Direct confirm
                             */

                            if (
                                [
                                    "confirm",
                                    "yes",
                                    "done",
                                    "checkout"
                                ].includes(
                                    normalizedText
                                )
                            ) {

                                await sendFinalBill(
                                    phoneNumberId,
                                    from,
                                    session
                                );

                                continue;
                            }

                            /*
                             * Direct edit
                             */

                            if (
                                normalizedText ===
                                "edit"
                            ) {

                                await sendEditItemOptions(
                                    phoneNumberId,
                                    from,
                                    session
                                );

                                continue;
                            }

                            /*
                             * User typed another product
                             */

                            const parsed =
                                parseOrderText(
                                    incomingText
                                );

                            const validItems =
                                parsed.filter(
                                    item =>
                                        !item.error
                                );

                            if (
                                validItems.length
                            ) {

                                const cartOperation =
                                    addToCart(
                                        session,
                                        validItems
                                    );

                                await sendPreOrderBill(
                                    phoneNumberId,
                                    from,
                                    session,
                                    buildCartOperationNote(cartOperation)
                                );

                                continue;
                            }

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "Please use the buttons above or type another product."
                            );

                            continue;
                        }

                        /*
                         * FINAL
                         */

                        if (
                            session.status ===
                            STATES.FINAL
                        ) {

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "Please tap *Pay Now* or *Add Address* above."
                            );

                            continue;
                        }

                        /*
                         * COMPLETED
                         */

                        if (
                            session.status ===
                            STATES.COMPLETED
                        ) {

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                "✅ Your previous order is already completed.\n\n" +
                                "Type *Hi* to start a new order."
                            );

                            continue;
                        }

                        /*
                         * IDLE / NEW ORDER
                         */

                        const parsed =
                            parseOrderText(
                                incomingText
                            );

                        const validItems =
                            parsed.filter(
                                item =>
                                    !item.error
                            );

                        const invalidItems =
                            parsed.filter(
                                item =>
                                    item.error
                            );

                        if (
                            validItems.length ===
                            0
                        ) {

                            let message =
                                "❌ Product not found.";

                            if (
                                invalidItems.length
                            ) {
                                message +=
                                    `\n\n${invalidItems.map(i => i.error).join("\n")}`;
                            }

                            message +=
                                "\n\nExample:\n" +
                                "*Atta 2 Kg*";

                            await sendTextMessage(
                                phoneNumberId,
                                from,
                                message
                            );

                            continue;
                        }

                        const cartOperation =
                            addToCart(
                                session,
                                validItems
                            );

                        if (
                            invalidItems.length
                        ) {

                            await sendTextMessage(
                                phoneNumberId,
                                from,

                                `⚠️ Some items were not found:\n\n` +
                                invalidItems
                                    .map(
                                        i =>
                                            `• ${i.error}`
                                    )
                                    .join("\n")
                            );
                        }

                        await sendPreOrderBill(
                            phoneNumberId,
                            from,
                            session,
                            buildCartOperationNote(cartOperation)
                        );
                    }
                }
            }

            return res.sendStatus(200);

        }
        catch (error) {

            console.error(
                "❌ Webhook Error:",
                error.response?.data ||
                error.message ||
                error
            );

            /*
             * Always return 200 to WhatsApp
             * so Meta does not continuously retry
             * the same event.
             */

            return res.sendStatus(200);
        }
    }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
    "/",
    (req, res) => {
        res.status(200).json({
            success: true,
            message:
                "CODE Bot WhatsApp server is running",
            vendor_id:
                DEFAULT_VENDOR_ID,
            products:
                productCatalog.length,
            units:
                unitCatalog.length
        });
    }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

    try {

        console.log(
            "=========================================="
        );

        console.log(
            "🚀 Starting CODE Bot WhatsApp Server..."
        );

        console.log(
            "=========================================="
        );

        /*
         * Check required environment variables.
         */

        if (!TOKEN) {
            console.warn(
                "⚠️ TOKEN is not configured in .env"
            );
        }

        if (!MYTOKEN) {
            console.warn(
                "⚠️ MYTOKEN is not configured in .env"
            );
        }

        /*
         * Test database.
         */

        await dbQuery(
            "SELECT 1"
        );

        console.log(
            "✅ MySQL database connected"
        );

        /*
         * Load products and units.
         */

        await loadCatalogs();

        /*
         * Start HTTP server.
         */

        app.listen(
            PORT,
            () => {

                console.log(
                    "=========================================="
                );

                console.log(
                    `🚀 Webhook is listening on port ${PORT}`
                );

                console.log(
                    `🌐 http://localhost:${PORT}`
                );

                console.log(
                    `🏪 Vendor ID: ${DEFAULT_VENDOR_ID}`
                );

                console.log(
                    `📦 Products: ${productCatalog.length}`
                );

                console.log(
                    `⚖️ Units: ${unitCatalog.length}`
                );

                console.log(
                    "=========================================="
                );
            }
        );

    }
    catch (error) {

        console.error(
            "=========================================="
        );

        console.error(
            "❌ Failed to start server"
        );

        console.error(
            error.message
        );

        console.error(
            "=========================================="
        );

        process.exit(1);
    }
}

/* =========================================================
   START
========================================================= */

startServer();