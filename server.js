/**
 * Handloom House — backend server
 * -------------------------------
 * Express server. Serves the static frontend from /public and a small JSON
 * API backed by a JSON file at /data/store.json.
 *
 * Security tools used (run `npm install` first):
 *   - helmet              -> sets protective HTTP response headers (CSP, etc.)
 *   - express-rate-limit  -> throttles brute-force attempts on auth routes
 *   - csurf               -> CSRF token check on every state-changing request
 *   - cookie-parser       -> required by csurf to read/write the token cookie
 *
 * Run with:  npm install && npm start
 * Then open: http://localhost:3000            (customer storefront)
 *            http://localhost:3000/admin.html (admin dashboard)
 */

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const csrf = require("csurf");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "data", "store.json");
const SEED_PRODUCTS_PATH = path.join(ROOT, "data", "seed-products.json");

// ---------------------------------------------------------------------------
// Order tracking & help desk — constants and helpers
// ---------------------------------------------------------------------------

// The delivery journey, in order. An order's `status` is always one of these.
const ORDER_STATUS_FLOW = ["placed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered"];
// Until the admin sets a real date, an order shows an estimate this many days after it was placed.
const DEFAULT_DELIVERY_DAYS = 7;

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];
const TICKET_TYPES = ["complaint", "question"];
const TICKET_TOPICS = ["delivery_delay", "damaged_item", "wrong_item", "tracking", "payment", "address_change", "other"];
const TICKET_SUBJECT_MIN = 3;
const TICKET_SUBJECT_MAX = 120;
const TICKET_MESSAGE_MIN = 10; // first message only; later replies can be short
const TICKET_TEXT_MAX = 2000;
const TICKET_MAX_MESSAGES = 100; // keeps one runaway thread from bloating the JSON file

// n-digit random number (no leading zero), from the OS's secure random source.
function randomDigits(n) {
  return String(crypto.randomInt(10 ** (n - 1), 10 ** n));
}

// Builds e.g. "HH483920", retrying until `isTaken` says it's free. If a
// prefix ever gets crowded, the number quietly grows a digit rather than
// looping forever.
function uniqueId(prefix, digits, isTaken) {
  for (let attempt = 0; ; attempt++) {
    const id = prefix + randomDigits(digits + Math.floor(attempt / 20));
    if (!isTaken(id)) return id;
  }
}

function localDateString(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Estimated delivery, as "YYYY-MM-DD", DEFAULT_DELIVERY_DAYS after `placedAtIso`.
function defaultExpectedDelivery(placedAtIso) {
  const d = new Date(placedAtIso || Date.now());
  d.setDate(d.getDate() + DEFAULT_DELIVERY_DAYS);
  return localDateString(d);
}

// True only for real calendar dates in "YYYY-MM-DD" form (rejects 2026-02-31).
function isValidDateString(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  if (v < "2000-01-01" || v > "2100-12-31") return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Only ever http(s) — blocks javascript:, data:, etc. in courier links.
function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Trimmed string, or "" for anything that isn't a string (objects, arrays, ...).
function textField(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

const TRACKING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _\-/.]{1,39}$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{5,20}$/;

// Fills in the tracking fields on orders saved before order tracking existed.
// Safe to run repeatedly. Returns true if it changed anything.
// (expectedDelivery uses `=== undefined` so an admin clearing it — null — sticks.)
function normalizeOrder(db, o) {
  let changed = false;
  if (!ORDER_STATUS_FLOW.includes(o.status)) { o.status = "placed"; changed = true; }
  if (!Array.isArray(o.statusHistory) || o.statusHistory.length === 0) {
    o.statusHistory = [{ status: "placed", at: o.createdAt || new Date().toISOString() }];
    changed = true;
  }
  if (!o.trackingId) {
    o.trackingId = uniqueId("HHT", 9, (id) => db.orders.some((x) => x.trackingId === id));
    changed = true;
  }
  if (o.expectedDelivery === undefined) { o.expectedDelivery = defaultExpectedDelivery(o.createdAt); changed = true; }
  if (!o.courier || typeof o.courier !== "object" || Array.isArray(o.courier)) {
    o.courier = { name: "", phone: "", trackingUrl: "" };
    changed = true;
  }
  if (typeof o.shippingNote !== "string") { o.shippingNote = ""; changed = true; }
  if (!o.updatedAt) { o.updatedAt = o.createdAt || new Date().toISOString(); changed = true; }
  return changed;
}

// ---------------------------------------------------------------------------
// Tiny "database" — a JSON file on disk. Fine for a small demo/class project;
// swap for a real database later without touching the route logic much.
// ---------------------------------------------------------------------------

function loadSeedProducts() {
  try {
    return JSON.parse(fs.readFileSync(SEED_PRODUCTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function defaultDB() {
  return {
    admin: null, // created on first run, see ensureAdminSeed()
    customers: [],
    products: loadSeedProducts(),
    orders: [],
    reviews: [],
    tickets: [], // help desk tickets
    nextProductNumericId: 1000,
  };
}

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    writeDB(defaultDB());
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  // Backfill fields for stores created before reviews/multi-image support existed.
  if (!Array.isArray(db.reviews)) db.reviews = [];
  db.products = (db.products || []).map((p) => ({
    ...p,
    images: Array.isArray(p.images) && p.images.length ? p.images : p.image ? [p.image] : [],
  }));
  // ...and before order tracking / the help desk existed. Old orders get a
  // tracking ID, an estimated delivery date and a status history, saved once.
  if (!Array.isArray(db.tickets)) db.tickets = [];
  if (!Array.isArray(db.orders)) db.orders = [];
  let migrated = false;
  for (const o of db.orders) if (normalizeOrder(db, o)) migrated = true;
  if (migrated) writeDB(db);
  return db;
}

function writeDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Seed a default admin account (username: aleena / password: aleena1234) the
// first time the server runs, so there's a way in. CHANGE THIS PASSWORD before
// using the site for anything real — there's no UI for that yet, but you can
// edit data/store.json directly (delete the admin field and restart to
// re-seed) if you need to reset it.
function ensureAdminSeed() {
  const db = readDB();
  if (!db.admin) {
    const { salt, hash } = hashPassword("aleena1234");
    db.admin = { username: "aleena", salt, hash };
    writeDB(db);
    console.log("Seeded default admin login -> username: aleena  password: aleena1234");
    console.log("Change this before using the site for anything real.");
  }
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, built into Node — no bcrypt dependency needed)
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
}

// ---------------------------------------------------------------------------
// Sessions — random token in an httpOnly cookie, kept in memory. Restarting
// the server logs everyone out; acceptable for a demo/mini-project.
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> { role: 'admin'|'customer', id }

function createSession(role, id) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { role, id });
  return token;
}

// Attaches req.hhSession from the "session" cookie, if valid.
function sessionMiddleware(req, res, next) {
  const token = req.cookies.session;
  req.hhSession = token && sessions.has(token) ? { token, ...sessions.get(token) } : null;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.hhSession || req.hhSession.role !== role) {
      const msg = role === "admin" ? "Admin login required." : "Log in required.";
      return res.status(403).json({ error: msg });
    }
    next();
  };
}

// Password policy: at least 8 characters, with at least one uppercase letter,
// one lowercase letter, one number, and one special character.
const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";
function isStrongPassword(password) {
  if (typeof password !== "string" || password.length < 8) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

function publicCustomer(c) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone, createdAt: c.createdAt };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function ratingSummary(db, productId) {
  const reviews = db.reviews.filter((r) => r.productId === productId);
  if (reviews.length === 0) return { average: 0, count: 0 };
  const total = reviews.reduce((sum, r) => sum + r.rating, 0);
  return { average: Math.round((total / reviews.length) * 10) / 10, count: reviews.length };
}

function withRating(db, product) {
  return { ...product, rating: ratingSummary(db, product.id) };
}

function publicReview(r) {
  return {
    id: r.id,
    productId: r.productId,
    customerName: r.customerName,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// Normalizes a product's gender attribute. Valid values are "Men" and
// "Women"; anything else (including missing) is treated as unset, which is
// fine for non-apparel items like Home Textiles.
function normalizeGender(value) {
  return value === "Men" || value === "Women" ? value : null;
}
// keeping `image` (used by the grid/cart thumbnails) as the first photo.
function normalizeImages(body, existing) {
  let images = existing ? existing.images || [] : [];
  if (Array.isArray(body.images)) {
    images = body.images.map((s) => String(s).trim()).filter(Boolean);
  } else if (body.image !== undefined) {
    images = body.image ? [String(body.image).trim()] : [];
  }
  return { images, image: images[0] || null };
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

// --- helmet: security-related HTTP response headers (CSP, no-sniff, etc.) --
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Product swatches are painted with inline style="background:..." from
        // JS, so style-src needs 'unsafe-inline'. Everything else stays locked
        // to 'self'.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "10mb" })); // covers base64 images up to ~6MB
app.use(sessionMiddleware);

// --- express-rate-limit: throttle brute-force attempts on auth routes ------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a while and try again." },
});

// --- express-rate-limit: keep the help desk from being flooded -------------
// Generous on purpose: several people on one shared network (e.g. a class
// demoing this project) should never hit these in normal use.
const ticketLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tickets submitted. Please wait a while and try again." },
});
const ticketReplyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages sent. Please wait a while and try again." },
});

// --- csurf: CSRF token required on every state-changing API request --------
// Token is stored in its own (non-httpOnly) cookie so the frontend JS can
// read it via GET /api/csrf-token and echo it back in an X-CSRF-Token header.
const csrfProtection = csrf({ cookie: { httpOnly: false, sameSite: "lax" } });

const apiRouter = express.Router();
apiRouter.use(csrfProtection);

apiRouter.get("/csrf-token", (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// ---- Auth: customer signup ----
apiRouter.post("/auth/signup", authLimiter, (req, res) => {
  const body = req.body || {};
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const phone = (body.phone || "").trim();
  const password = body.password || "";
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
  }
  const db = readDB();
  if (db.customers.some((c) => c.email === email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  const { salt, hash } = hashPassword(password);
  const customer = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    email,
    phone,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  db.customers.push(customer);
  writeDB(db);
  const token = createSession("customer", customer.id);
  res.cookie("session", token, { httpOnly: true, path: "/", sameSite: "lax" });
  res.status(201).json({ customer: publicCustomer(customer) });
});

// ---- Auth: customer login ----
apiRouter.post("/auth/login", authLimiter, (req, res) => {
  const body = req.body || {};
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const db = readDB();
  const customer = db.customers.find((c) => c.email === email);
  if (!customer || !verifyPassword(password, customer.salt, customer.hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  const token = createSession("customer", customer.id);
  res.cookie("session", token, { httpOnly: true, path: "/", sameSite: "lax" });
  res.status(200).json({ customer: publicCustomer(customer) });
});

// ---- Auth: admin login ----
apiRouter.post("/auth/admin-login", authLimiter, (req, res) => {
  const body = req.body || {};
  const username = (body.username || "").trim();
  const password = body.password || "";
  const db = readDB();
  if (!db.admin || db.admin.username !== username || !verifyPassword(password, db.admin.salt, db.admin.hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  const token = createSession("admin", "admin");
  res.cookie("session", token, { httpOnly: true, path: "/", sameSite: "lax" });
  res.status(200).json({ admin: { username: db.admin.username } });
});

// ---- Auth: logout ----
apiRouter.post("/auth/logout", (req, res) => {
  if (req.hhSession) sessions.delete(req.hhSession.token);
  res.clearCookie("session", { path: "/" });
  res.status(200).json({ ok: true });
});

// ---- Session check ----
apiRouter.get("/session", (req, res) => {
  if (!req.hhSession) return res.status(200).json({ role: null });
  const db = readDB();
  if (req.hhSession.role === "admin") {
    return res.status(200).json({ role: "admin", username: db.admin ? db.admin.username : "admin" });
  }
  const customer = db.customers.find((c) => c.id === req.hhSession.id);
  if (!customer) return res.status(200).json({ role: null });
  res.status(200).json({ role: "customer", customer: publicCustomer(customer) });
});

// ---- Products: public list ----
apiRouter.get("/products", (req, res) => {
  const db = readDB();
  res.status(200).json({ products: db.products.map((p) => withRating(db, p)) });
});

// ---- Products: public single item ----
apiRouter.get("/products/:id", (req, res) => {
  const db = readDB();
  const product = db.products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.status(200).json({ product: withRating(db, product) });
});

// ---- Products: admin add ----
apiRouter.post("/products", requireRole("admin"), (req, res) => {
  const body = req.body || {};
  const required = ["name", "category", "price"];
  for (const field of required) {
    if (!body[field]) return res.status(400).json({ error: `Missing field: ${field}` });
  }
  const db = readDB();
  const id = "p" + db.nextProductNumericId++;
  const { images, image } = normalizeImages(body, null);
  const product = {
    id,
    name: String(body.name),
    category: String(body.category),
    type: body.type || "kurta",
    color: body.color || "#1B2A4A",
    price: Number(body.price),
    sizes: Array.isArray(body.sizes) && body.sizes.length ? body.sizes : ["Free size"],
    collection: body.collection || "new-season",
    gender: normalizeGender(body.gender),
    image,
    images,
    desc: body.desc || "",
  };
  db.products.push(product);
  writeDB(db);
  res.status(201).json({ product: withRating(db, product) });
});

// ---- Products: admin update / delete ----
apiRouter
  .route("/products/:id")
  .put(requireRole("admin"), (req, res) => {
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Product not found." });
    const body = req.body || {};
    const existing = db.products[idx];
    const { images, image } = normalizeImages(body, existing);
    db.products[idx] = {
      ...existing,
      ...body,
      id: existing.id,
      price: body.price !== undefined ? Number(body.price) : existing.price,
      gender: body.gender !== undefined ? normalizeGender(body.gender) : existing.gender,
      images,
      image,
    };
    writeDB(db);
    res.status(200).json({ product: withRating(db, db.products[idx]) });
  })
  .delete(requireRole("admin"), (req, res) => {
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Product not found." });
    db.products.splice(idx, 1);
    writeDB(db);
    res.status(200).json({ ok: true });
  });

// ---- Reviews: public list for a product ----
apiRouter.get("/products/:id/reviews", (req, res) => {
  const db = readDB();
  const product = db.products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  const reviews = db.reviews
    .filter((r) => r.productId === req.params.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(publicReview);
  res.status(200).json({ reviews, rating: ratingSummary(db, req.params.id) });
});

// ---- Reviews: has the logged-in customer ordered this product? ----
apiRouter.get("/products/:id/can-review", requireRole("customer"), (req, res) => {
  const db = readDB();
  const hasOrdered = db.orders.some(
    (o) => o.customerId === req.hhSession.id && o.items.some((i) => i.id === req.params.id)
  );
  res.status(200).json({ canReview: hasOrdered });
});

// ---- Reviews: customer submits (or updates) their review for a product ----
apiRouter.post("/products/:id/reviews", requireRole("customer"), (req, res) => {
  const db = readDB();
  const product = db.products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });

  const body = req.body || {};
  const rating = Number(body.rating);
  const comment = String(body.comment || "").trim().slice(0, 800);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be a whole number from 1 to 5." });
  }

  const customer = db.customers.find((c) => c.id === req.hhSession.id);
  if (!customer) return res.status(401).json({ error: "Session expired, please log in again." });

  const hasOrdered = db.orders.some(
    (o) => o.customerId === customer.id && o.items.some((i) => i.id === req.params.id)
  );
  if (!hasOrdered) {
    return res.status(403).json({ error: "You can review a product after ordering it." });
  }

  const now = new Date().toISOString();
  const existingIdx = db.reviews.findIndex(
    (r) => r.productId === req.params.id && r.customerId === customer.id
  );
  let review;
  if (existingIdx !== -1) {
    review = { ...db.reviews[existingIdx], rating, comment, customerName: customer.name, updatedAt: now };
    db.reviews[existingIdx] = review;
  } else {
    review = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      productId: req.params.id,
      customerId: customer.id,
      customerName: customer.name,
      rating,
      comment,
      createdAt: now,
      updatedAt: now,
    };
    db.reviews.push(review);
  }
  writeDB(db);
  res
    .status(existingIdx !== -1 ? 200 : 201)
    .json({ review: publicReview(review), rating: ratingSummary(db, req.params.id) });
});

// ---- Admin: upload a product photo ----
apiRouter.post("/admin/upload-image", requireRole("admin"), (req, res) => {
  const body = req.body || {};
  const dataUrl = body.dataUrl || "";
  const originalName = String(body.filename || "photo").trim();

  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return res.status(400).json({ error: "Please choose an image file (JPG, PNG, WEBP, or GIF)." });
  }
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: "Image is too large — please use a file under 6MB." });
  }

  // sanitize a filename from the original name, then guarantee uniqueness
  const base = path.basename(originalName, path.extname(originalName))
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "product";
  const imagesDir = path.join(PUBLIC_DIR, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  let fileName = `${base}.${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(imagesDir, fileName))) {
    fileName = `${base}-${counter}.${ext}`;
    counter++;
  }
  fs.writeFileSync(path.join(imagesDir, fileName), buffer);
  res.status(201).json({ path: `images/${fileName}` });
});

// ---- Orders: customer places an order ----
apiRouter.post("/orders", requireRole("customer"), (req, res) => {
  const db = readDB();
  const customer = db.customers.find((c) => c.id === req.hhSession.id);
  if (!customer) return res.status(401).json({ error: "Session expired, please log in again." });

  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return res.status(400).json({ error: "Cart is empty." });

  const total = items.reduce((sum, i) => sum + Number(i.price) * Number(i.qty), 0);
  const now = new Date().toISOString();
  const order = {
    id: uniqueId("HH", 6, (id) => db.orders.some((o) => o.id === id)),
    customerId: customer.id,
    customerName: body.name || customer.name,
    address: body.address || "",
    phone: body.phone || customer.phone,
    payment: body.payment || "cod",
    items,
    total,
    // --- tracking ---
    status: "placed",
    statusHistory: [{ status: "placed", at: now }],
    // Auto-assigned so every order has a tracking ID from day one; the admin
    // can replace it with the courier's own AWB/consignment number.
    trackingId: uniqueId("HHT", 9, (id) => db.orders.some((o) => o.trackingId === id)),
    expectedDelivery: defaultExpectedDelivery(now), // estimate; admin can change it
    courier: { name: "", phone: "", trackingUrl: "" },
    shippingNote: "",
    createdAt: now,
    updatedAt: now,
  };
  db.orders.push(order);
  writeDB(db);
  res.status(201).json({ order });
});

// ---- Orders: customer's own order history ----
apiRouter.get("/orders/mine", requireRole("customer"), (req, res) => {
  const db = readDB();
  const orders = db.orders.filter((o) => o.customerId === req.hhSession.id);
  res.status(200).json({ orders });
});

// ---- Admin: view all customers ----
apiRouter.get("/admin/customers", requireRole("admin"), (req, res) => {
  const db = readDB();
  res.status(200).json({ customers: db.customers.map(publicCustomer) });
});

// ---- Admin: view all orders ----
apiRouter.get("/admin/orders", requireRole("admin"), (req, res) => {
  const db = readDB();
  res.status(200).json({ orders: db.orders });
});

// ---- Admin: update an order's status / tracking / delivery details ----
// Every field is optional; only the ones sent are changed. Everything is
// validated before anything is applied, so a bad field never leaves the order
// half-updated.
apiRouter.put("/admin/orders/:id", requireRole("admin"), (req, res) => {
  const db = readDB();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const body = req.body || {};
  const bad = (msg) => res.status(400).json({ error: msg });

  let status;
  if (body.status !== undefined) {
    if (!ORDER_STATUS_FLOW.includes(body.status)) return bad("Unknown order status.");
    status = body.status;
  }

  let expectedDelivery;
  if (body.expectedDelivery !== undefined) {
    const v = textField(body.expectedDelivery);
    if (v === "") expectedDelivery = null; // cleared -> customer sees "to be confirmed"
    else if (!isValidDateString(v)) return bad("Expected delivery must be a valid date.");
    else expectedDelivery = v;
  }

  let trackingId;
  if (body.trackingId !== undefined) {
    const v = textField(body.trackingId);
    if (!TRACKING_ID_PATTERN.test(v)) {
      return bad("Tracking ID must be 2–40 characters: letters, numbers, spaces, and - _ / . only.");
    }
    trackingId = v;
  }

  let shippingNote;
  if (body.shippingNote !== undefined) {
    if (typeof body.shippingNote !== "string") return bad("Invalid shipping note.");
    shippingNote = textField(body.shippingNote);
    if (shippingNote.length > 300) return bad("Shipping note must be 300 characters or fewer.");
  }

  const courier = {};
  if (body.courier !== undefined) {
    const c = body.courier;
    if (!c || typeof c !== "object" || Array.isArray(c)) return bad("Invalid courier details.");
    if (c.name !== undefined) {
      if (typeof c.name !== "string") return bad("Invalid courier name.");
      courier.name = textField(c.name);
      if (courier.name.length > 60) return bad("Courier name must be 60 characters or fewer.");
    }
    if (c.phone !== undefined) {
      if (typeof c.phone !== "string") return bad("Invalid courier phone number.");
      courier.phone = textField(c.phone);
      if (courier.phone && !PHONE_PATTERN.test(courier.phone)) return bad("Courier phone number looks invalid.");
    }
    if (c.trackingUrl !== undefined) {
      if (typeof c.trackingUrl !== "string") return bad("Invalid tracking link.");
      courier.trackingUrl = textField(c.trackingUrl);
      if (courier.trackingUrl && (courier.trackingUrl.length > 300 || !isHttpUrl(courier.trackingUrl))) {
        return bad("Tracking link must be a web address starting with http:// or https://");
      }
    }
  }

  // --- all valid: apply ---
  const now = new Date().toISOString();
  if (status !== undefined && status !== order.status) {
    // Keep the timeline honest: moving backwards (e.g. fixing a mis-click)
    // discards the later steps' timestamps, and each step is stamped once.
    const idx = ORDER_STATUS_FLOW.indexOf(status);
    order.statusHistory = (order.statusHistory || []).filter((h) => ORDER_STATUS_FLOW.indexOf(h.status) <= idx);
    if (!order.statusHistory.some((h) => h.status === status)) order.statusHistory.push({ status, at: now });
    order.status = status;
  }
  if (expectedDelivery !== undefined) order.expectedDelivery = expectedDelivery;
  if (trackingId !== undefined) order.trackingId = trackingId;
  if (shippingNote !== undefined) order.shippingNote = shippingNote;
  order.courier = { ...order.courier, ...courier };
  order.updatedAt = now;
  writeDB(db);
  res.status(200).json({ order });
});

// ---------------------------------------------------------------------------
// Help desk — customers raise tickets about their orders; admin replies.
// Every customer route looks tickets up by BOTH ticket id and the logged-in
// customer's id, so one customer can never read or write another's tickets.
// ---------------------------------------------------------------------------

// What a customer is allowed to see of their own ticket.
function customerTicketView(t) {
  return {
    id: t.id,
    orderId: t.orderId,
    type: t.type,
    topic: t.topic,
    subject: t.subject,
    status: t.status,
    messages: t.messages,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---- Help desk: customer raises a ticket ----
apiRouter.post("/tickets", ticketLimiter, requireRole("customer"), (req, res) => {
  const db = readDB();
  const customer = db.customers.find((c) => c.id === req.hhSession.id);
  if (!customer) return res.status(401).json({ error: "Session expired, please log in again." });

  const body = req.body || {};
  const bad = (msg) => res.status(400).json({ error: msg });

  if (!TICKET_TYPES.includes(body.type)) return bad("Please choose whether this is a complaint or a question.");
  const topic = TICKET_TOPICS.includes(body.topic) ? body.topic : "other";

  const subject = textField(body.subject);
  if (subject.length < TICKET_SUBJECT_MIN || subject.length > TICKET_SUBJECT_MAX) {
    return bad(`Subject must be ${TICKET_SUBJECT_MIN}–${TICKET_SUBJECT_MAX} characters.`);
  }
  const message = textField(body.message);
  if (message.length < TICKET_MESSAGE_MIN || message.length > TICKET_TEXT_MAX) {
    return bad(`Message must be ${TICKET_MESSAGE_MIN}–${TICKET_TEXT_MAX} characters.`);
  }

  // Optional order link — but if given it must be one of THIS customer's orders.
  let orderId = null;
  const requestedOrder = textField(body.orderId);
  if (requestedOrder) {
    const order = db.orders.find((o) => o.id === requestedOrder && o.customerId === customer.id);
    if (!order) return bad("Please choose one of your own orders.");
    orderId = order.id;
  }

  const now = new Date().toISOString();
  const ticket = {
    id: uniqueId("HD-", 6, (id) => db.tickets.some((t) => t.id === id)),
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.email,
    orderId,
    type: body.type,
    topic,
    subject,
    status: "open",
    messages: [{ from: "customer", text: message, at: now }],
    createdAt: now,
    updatedAt: now,
  };
  db.tickets.push(ticket);
  writeDB(db);
  res.status(201).json({ ticket: customerTicketView(ticket) });
});

// ---- Help desk: customer's own tickets ----
apiRouter.get("/tickets/mine", requireRole("customer"), (req, res) => {
  const db = readDB();
  const tickets = db.tickets
    .filter((t) => t.customerId === req.hhSession.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(customerTicketView);
  res.status(200).json({ tickets });
});

// ---- Help desk: customer adds a follow-up message to their own ticket ----
apiRouter.post("/tickets/:id/reply", ticketReplyLimiter, requireRole("customer"), (req, res) => {
  const db = readDB();
  const ticket = db.tickets.find((t) => t.id === req.params.id && t.customerId === req.hhSession.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  if (ticket.status === "closed") {
    return res.status(409).json({ error: "This ticket is closed. Please raise a new ticket." });
  }
  const text = textField((req.body || {}).text);
  if (!text || text.length > TICKET_TEXT_MAX) {
    return res.status(400).json({ error: `Message must be 1–${TICKET_TEXT_MAX} characters.` });
  }
  if (ticket.messages.length >= TICKET_MAX_MESSAGES) {
    return res.status(409).json({ error: "This conversation is full. Please raise a new ticket." });
  }
  const now = new Date().toISOString();
  ticket.messages.push({ from: "customer", text, at: now });
  ticket.status = "open"; // a customer message always puts the ball back in support's court
  ticket.updatedAt = now;
  writeDB(db);
  res.status(200).json({ ticket: customerTicketView(ticket) });
});

// ---- Admin: all tickets ----
apiRouter.get("/admin/tickets", requireRole("admin"), (req, res) => {
  const db = readDB();
  const tickets = db.tickets.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.status(200).json({ tickets });
});

// ---- Admin: reply to a ticket and/or change its status ----
apiRouter.put("/admin/tickets/:id", requireRole("admin"), (req, res) => {
  const db = readDB();
  const ticket = db.tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });

  const body = req.body || {};
  let status = body.status;
  if (status !== undefined && !TICKET_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Unknown ticket status." });
  }
  const reply = textField(body.reply);
  if (reply.length > TICKET_TEXT_MAX) {
    return res.status(400).json({ error: `Reply must be ${TICKET_TEXT_MAX} characters or fewer.` });
  }
  if (!reply && (status === undefined || status === ticket.status)) {
    return res.status(400).json({ error: "Write a reply or change the status." });
  }
  if (reply && ticket.messages.length >= TICKET_MAX_MESSAGES) {
    return res.status(409).json({ error: "This conversation is full. Ask the customer to raise a new ticket." });
  }

  const now = new Date().toISOString();
  if (reply) {
    ticket.messages.push({ from: "admin", text: reply, at: now });
    // First reply on an untouched ticket means it's now being worked on.
    if (status === undefined && ticket.status === "open") status = "in_progress";
  }
  if (status !== undefined) ticket.status = status;
  ticket.updatedAt = now;
  writeDB(db);
  res.status(200).json({ ticket });
});

apiRouter.use((req, res) => res.status(404).json({ error: "Not found." }));

app.use("/api", apiRouter);

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Error handling (must be last) — catches bad/missing CSRF tokens and any
// other thrown errors so nothing leaks a stack trace to the client.
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  if (err && err.code === "EBADCSRFTOKEN") {
    return res.status(403).json({ error: "Invalid or expired security token — please refresh and try again." });
  }
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

ensureAdminSeed();

app.listen(PORT, () => {
  console.log(`Handloom House server running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at         http://localhost:${PORT}/admin.html`);
});
