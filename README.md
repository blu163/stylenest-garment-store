# Handloom House — Garment Store (with customer & admin accounts)

A handloom garment storefront with real customer accounts, an admin dashboard
for managing products, and order/customer data collection — backed by an
Express server with security middleware built in (see below). No external
database server to set up — data lives in a small JSON file.

## Run it

1. Open this folder in VS Code.
2. Open a terminal in VS Code (Terminal → New Terminal).
3. Install dependencies (one-time):
   ```
   npm install
   ```
4. Run:
   ```
   npm start
   ```
   (or `node server.js`)
5. Open **http://localhost:3000** in your browser — that's the customer storefront.
6. Open **http://localhost:3000/admin.html** for the admin dashboard.

## Security tools used

- **[helmet](https://www.npmjs.com/package/helmet)** — sets protective HTTP
  response headers (Content-Security-Policy, X-Frame-Options, X-Content-Type-Options,
  HSTS, etc.) on every response.
- **[express-rate-limit](https://www.npmjs.com/package/express-rate-limit)** —
  throttles login/signup attempts (20 requests per 15 minutes per IP) to slow
  down brute-force password guessing, and separately limits how fast Help Desk
  tickets and replies can be submitted.
- **[csurf](https://www.npmjs.com/package/csurf)** — requires a valid CSRF
  token (fetched from `GET /api/csrf-token`) on every state-changing request
  (POST/PUT/DELETE), so another site can't submit forms on a logged-in user's
  behalf. Note: `csurf` is no longer maintained upstream; it still works fine
  here, but if you outgrow it, `csrf-csrf` is the actively-maintained
  replacement with a similar API.
- **cookie-parser** — required by csurf to read/write its token cookie.
- Passwords are still hashed with Node's built-in `crypto.scryptSync` (salted,
  slow hash) and compared with `crypto.timingSafeEqual`, and session tokens
  are still random, httpOnly, `SameSite=Lax` cookies, as before.

Not included yet, worth adding before a real deployment: session expiry/idle
timeout (sessions currently only end on logout or server restart), and
HTTPS/TLS termination (usually handled by a reverse proxy, not the app
itself).

**Note:** don't use Live Server or open `index.html` directly — the site
needs the Node server running (`node server.js`) because logins, the product
catalogue, and orders all live on the backend, not just in the browser.

## Default admin login

- **Username:** `aleena`
- **Password:** `aleena1234`

This is created automatically the first time you run the server (you'll see
a reminder printed in the terminal). Change it by editing `data/store.json`
after your first run, or delete that file's `admin` field and restart the
server to re-seed it.

## What's inside

```
garment-store/
├── server.js              Express server: static files + JSON API
├── package.json
├── data/
│   ├── seed-products.json   Starting catalogue, loaded on first run
│   └── store.json           The actual "database" — created automatically.
│                             Holds admin login, customers, products, orders, reviews.
└── public/                  Everything served to the browser
    ├── index.html            Customer storefront
    ├── product.html          Product detail page (gallery + reviews)
    ├── orders.html            Order tracking (status tracker, delivery details)
    ├── help.html              Help Desk (raise + follow support tickets)
    ├── admin.html             Admin dashboard
    ├── css/style.css, css/admin.css
    ├── js/shared.js            Cart, account panel, checkout — shared by all pages
    ├── js/app.js                Storefront-specific logic (catalogue, filters)
    ├── js/product.js            Product page logic (gallery, reviews)
    ├── js/orders.js             Order tracking page logic
    ├── js/help.js               Help Desk page logic
    ├── js/admin.js               Admin dashboard logic
    ├── manifest.json, sw.js    PWA support (installable, offline shell)
    ├── icons/
    └── images/                 Product photos live here
```

## How the accounts work

**Customers** sign up / log in from the account icon in the storefront
header (top right, next to the cart). Logging in is required to check out —
this is what ties an order to a real customer record instead of an
anonymous cart. Logged-in customers can see their own past orders from the
same account panel.

**The admin** logs in separately at `/admin.html` — this is a completely
different login from customer accounts, and an admin session can't browse
the customer account panel or vice versa. From the dashboard, the admin can:

- **Products** — add, edit, or delete catalogue items (name, category,
  price, sizes, collection tag, description, and photos).
- **Customers** — see everyone who's signed up: name, email, phone, and
  when they joined. This is the "collect customer data" part — every
  signup is stored server-side in `data/store.json`.
- **Orders** — every order placed, with the customer's name, what they
  bought, the total, payment method, and timestamp. Click **Manage** on any
  order to update its status, expected delivery date, tracking ID, courier
  details and a note for the customer (see *Order tracking* below).
- **Help Desk** — every support ticket customers have raised. Open one to read
  the conversation, reply, and set its status. The tab shows a badge with the
  number of tickets still waiting for a reply.

## Order tracking

After checkout, the confirmation shows the **Order ID**, **Tracking ID** and
**expected delivery date**, with a *Track this order* button. Customers can
come back any time via **My Orders** in the header, the footer, or their
account panel (`orders.html`).

For each order the tracker page shows:

- a visual progress tracker: **Placed → Confirmed → Packed → Shipped → Out for
  Delivery → Delivered**, with a timestamp on each completed step (horizontal
  on desktop, vertical on phones)
- the expected delivery date (or the actual delivery date once delivered)
- the order ID and tracking ID
- courier / shipping details (courier name, contact number, a link to the
  courier's own tracking page, and any note from you)
- the shipping address, the items, the total and the payment method

**What the admin controls** (Admin → Orders → *Manage*): status, expected
delivery date, tracking ID, courier name / phone / tracking link, and a note.
Status can move forward, skip steps, or go back to fix a mistake — moving back
removes the later steps' timestamps so the timeline stays honest.

Defaults worth knowing:

- Every order gets an auto-generated tracking ID (`HHT` + 9 digits) when it is
  placed. Replace it with the courier's consignment / AWB number once you have
  one.
- Every order gets an *estimated* delivery date 7 days after it was placed.
  Change `DEFAULT_DELIVERY_DAYS` at the top of `server.js` to alter that, or set
  the real date per order.
- Orders saved before this feature existed are upgraded automatically the first
  time the server reads them (a tracking ID, an estimated date and a status
  history are added). Nothing else about them changes.
- Courier tracking links must start with `http://` or `https://`.

Customers can only ever see their **own** orders — the API filters by the
logged-in customer, and opening `orders.html?id=…` with someone else's order ID
just shows the customer's own newest order.

## Help Desk

Logged-in customers open **Help Desk** (`help.html`) to raise a **complaint** or
a **question**, optionally tied to one of their orders (or a general question).
They pick a topic (delivery delay, damaged item, wrong item, tracking, payment,
change address / cancel, other), write a subject and message, and immediately
get a **ticket number** like `HD-482913`.

Each ticket is a conversation: the admin's replies appear under *Your tickets*,
and the customer can reply back. Ticket statuses are **Open** (waiting for
support), **In progress**, **Resolved** and **Closed**. A customer reply on an
open, in-progress or resolved ticket puts it back to *Open*; closed tickets take
no more customer replies, so the customer raises a new one.

Limits: subject 3–120 characters, first message 10–2000 characters, up to 100
messages per ticket. Ticket creation and replies are rate-limited per IP
(30 tickets and 90 replies per hour) to blunt spam.

Tickets are stored in `data/store.json` under `tickets`.

## Adding product photos

In the admin dashboard, the **Photos** field on the product form accepts
multiple files at once — select several, and they upload one by one into a
gallery you can reorder ("Make main") or remove from, right in the form. The
first photo becomes the main/thumbnail image shown in the catalogue grid and
cart. You can still edit `data/store.json` directly if you'd rather set
`"images": ["images/front.jpg", "images/back.jpg"]` on a product by hand.

Products without any photo keep using the generated icon.

## Product page & reviews

Clicking a product's image in the catalogue opens a dedicated page
(`product.html?id=...`) instead of a quick-view popup:
- a photo gallery with arrow navigation, if the product has more than one image
- full description, size picker, and add-to-cart
- a star rating summary and the list of customer reviews
- a review form (rating 1–5 + optional comment) — **only for customers who
  have actually ordered that product** (checked against their real order
  history, not just a hidden UI flag). Submitting again updates their
  existing review rather than adding a duplicate.

Reviews are stored in `data/store.json` alongside everything else, and the
average rating is also shown as stars under each product in the catalogue
grid.

## Notes on how this is built

- **No database server** — `data/store.json` is the whole database, read
  and written directly by `server.js`. Fine for a class project or small
  shop; if this ever needs to handle real traffic or multiple people
  editing at once, swap it for a proper database (MySQL, Postgres, SQLite,
  etc.) — the route logic in `server.js` is written so that's a contained
  change.
- **Passwords are hashed** (Node's built-in `scrypt`, salted per user) —
  never stored in plain text.
- **Sessions live in server memory** — restarting the server logs everyone
  out. Fine for development; a real deployment would persist sessions too.
- **"Place order" is a real order now** — it's saved to `data/store.json`
  and tied to the logged-in customer's account, and shows up in the admin
  Orders tab. There's still no real payment gateway — Cash on Delivery / UPI
  are recorded as a preference, not actually charged.
