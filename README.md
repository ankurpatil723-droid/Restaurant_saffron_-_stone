# 🍽️ Saffron & Stone — Restaurant Web Application & Backend

A full-stack, production-ready restaurant website and ordering system featuring an artisanal digital dining menu, shopping basket, automated calculations (taxes, discounts), UPI QR payment integration, WhatsApp order/reservation dispatch, and an Express + Supabase PostgreSQL backend.

---

## 📋 Table of Contents
1. [Project Overview](#project-overview)
2. [Local Setup & Run Steps](#local-setup--run-steps)
3. [Environment Variables (.env)](#environment-variables-env)
4. [Postman Test Collection](#postman-test-collection)
5. [Deployment Guide](#deployment-guide)
   - [Backend on Render](#backend-deployment-render)
   - [Frontend on Netlify / GitHub Pages](#frontend-deployment-netlify--github-pages)
6. [Multi-Client Customization Guide (CONFIG)](#multi-client-customization-guide-config)
7. [Legal & Policy Pages](#legal--policy-pages)

---

## 🚀 Project Overview

- **Frontend**: Single-page modern application (`index.html`) using semantic HTML5, Vanilla CSS design tokens (warm cream & forest green), accessible modals (ARIA, focus-trap), offline-capable cart via `localStorage`, dynamic UPI payment link & QR generator, and direct WhatsApp dispatch.
- **Backend**: Node.js & Express server located in `/backend` using `@supabase/supabase-js`, `helmet`, `cors`, `express-rate-limit`, and direct server-side menu price verification.
- **Database**: Supabase PostgreSQL tables (`orders`, `reservations`, `subscribers`) with Row Level Security (RLS).

---

## 💻 Local Setup & Run Steps

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Web Browser**: Chrome, Edge, Safari, or Firefox

### 2. Backend Setup
```bash
# Navigate to the backend directory
cd backend

# Install dependencies
npm install

# Create and configure .env
# (Copy from .env.example and add your Supabase credentials)
cp .env.example .env

# Start the server (runs on http://localhost:3000)
npm start

# Or start in watch mode for development
npm run dev
```

### 3. Frontend Setup
Because `index.html` is a static web application, serve it from any local static HTTP server (default expected origin: `http://127.0.0.1:5500` or `http://localhost:5500`):

**Option A: VS Code Live Server**
- Open the workspace in VS Code.
- Right-click `index.html` and select **"Open with Live Server"**.

**Option B: Python HTTP Server**
```bash
# From the project root
python -m http.server 5500
# Open http://localhost:5500 in your browser
```

**Option C: npx serve**
```bash
npx serve -p 5500 .
```

---

## 🔐 Environment Variables (.env)

The backend strictly reads all secrets from `backend/.env`. Never commit `.env` to version control.

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase Project REST URL | `https://xyzproject.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key (bypasses RLS for backend tasks) | `sb_secret_...` |
| `ALLOWED_ORIGIN` | Allowed client origin for CORS | `http://127.0.0.1:5500` *(or production domain)* |
| `ADMIN_KEY` | Secret token required in `x-admin-key` header to view orders | `256-bit random hex string` |
| `PORT` | Local port for Express server | `3000` |
| `DATABASE_URL` *(optional)* | PostgreSQL connection string with PgBouncer transaction pooler | `postgresql://...:6543/postgres?pgbouncer=true` |
| `DIRECT_URL` *(optional)* | PostgreSQL session pooler for migrations / Prisma schema push | `postgresql://...:5432/postgres` |

---

## 📮 Postman Test Collection

Import these requests into Postman or run them with `curl` to verify all routes and security controls:

### 1. Place Valid Order (With Server Price Calculation)
- **Method**: `POST`
- **URL**: `http://localhost:3000/api/orders`
- **Headers**: `Content-Type: application/json`
- **Body (raw JSON)**:
  ```json
  {
    "name": "Priya Sharma",
    "phone": "9823012345",
    "type": "Delivery",
    "address": "Flat 402, Green Meadows, Koregaon Park, Pune",
    "notes": "Please deliver before 8 PM",
    "coupon": "WELCOME10",
    "items": [
      { "id": "s1", "name": "Garden Avocado Sourdough", "qty": 2 },
      { "id": "m4", "name": "Old Delhi Butter Chicken Pot", "qty": 1 }
    ]
  }
  ```
- **Expected Status**: `201 Created`
- **Expected Response**:
  ```json
  {
    "orderId": "SS417056",
    "subtotal": 897,
    "discount": 90,
    "tax": 40,
    "total": 847
  }
  ```
  *(Note: Client prices are strictly ignored; calculations are verified from the server-side menu map).*

---

### 2. Order Validation Error Tests (`400 Bad Request`)
- **Missing Customer Name**:
  - Body: `{"phone": "9876543210", "type": "Pickup", "items": [{"id": "s1", "qty": 1}]}`
  - Response: `{"error": "Customer name is required"}`
- **Invalid Indian Phone Number**:
  - Body: `{"name": "Aarav", "phone": "12345", "type": "Pickup", "items": [{"id": "s1", "qty": 1}]}`
  - Response: `{"error": "Valid 10-digit phone number starting with 6-9 is required"}`
- **Delivery Missing Address**:
  - Body: `{"name": "Aarav", "phone": "9876543210", "type": "Delivery", "address": "", "items": [{"id": "s1", "qty": 1}]}`
  - Response: `{"error": "Delivery address is required for Delivery orders"}`
- **Invalid Quantity Exceeding Cap (> 20)**:
  - Body: `{"name": "Aarav", "phone": "9876543210", "type": "Pickup", "items": [{"id": "s1", "qty": 25}]}`
  - Response: `{"error": "Item quantity must be an integer between 1 and 20"}`

---

### 3. Book Table Reservation
- **Method**: `POST`
- **URL**: `http://localhost:3000/api/reservations`
- **Headers**: `Content-Type: application/json`
- **Body (raw JSON)**:
  ```json
  {
    "name": "Aarav Patel",
    "email": "aarav.patel@example.com",
    "phone": "9876543210",
    "guests": 4,
    "date": "2026-10-25",
    "time": "8:00 PM (Dinner)",
    "notes": "Window table preferred"
  }
  ```
- **Expected Status**: `201 Created`
- **Expected Response**: `{"success": true, "message": "Reservation confirmed"}`

---

### 4. Newsletter Subscription (Upsert / Duplicate Handling)
- **Method**: `POST`
- **URL**: `http://localhost:3000/api/subscribe`
- **Headers**: `Content-Type: application/json`
- **Body (raw JSON)**:
  ```json
  {
    "email": "gourmet.lover@example.com"
  }
  ```
- **Expected Status**: `200 OK`
- **Expected Response**: `{"success": true, "message": "Subscribed successfully"}`
  *(Submitting the same email again succeeds without throwing database constraint errors).*

---

### 5. Fetch Latest Orders (Admin Only)
- **Method**: `GET`
- **URL**: `http://localhost:3000/api/orders`
- **Headers**:
  - `x-admin-key: <YOUR_ADMIN_KEY>`
- **Expected Status**: `200 OK`
- **Unauthorized Status**: `401 Unauthorized` when `x-admin-key` is missing or invalid.

---

## 🌐 Deployment Guide

### Backend Deployment (Render)

1. Push your repository to GitHub.
2. Sign in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Web Service**.
4. Select your repository.
5. Fill in the deployment details:
   - **Name**: `restaurant-backend` (or your client's name)
   - **Region**: Closest to your database (e.g., Singapore / Frankfurt)
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free or Starter
6. In **Environment Variables**, add:
   - `SUPABASE_URL`: Your Supabase URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase secret service role key
   - `ALLOWED_ORIGIN`: Your production frontend URL (e.g. `https://your-restaurant.netlify.app`)
   - `ADMIN_KEY`: Generated random 256-bit hex key
   - `PORT`: `10000` *(Render default)*
7. Click **Create Web Service**. Note your public URL (e.g. `https://restaurant-backend.onrender.com`).

---

### Frontend Deployment (Netlify / GitHub Pages)

#### Step 1: Update API Endpoint in `index.html`
Before deploying, change the API endpoint at the top of the `<script>` tag in `index.html`:
```js
// Change this from localhost to your Render URL:
const API = "https://restaurant-backend.onrender.com";
```

#### Deploying on Netlify
1. Log in to [Netlify](https://app.netlify.com).
2. Click **Add new site** → **Import an existing project** → GitHub.
3. Select your repository.
4. Settings:
   - **Branch to deploy**: `main`
   - **Base directory**: Leave blank (root `.`)
   - **Publish directory**: Leave blank (root `.`)
5. Click **Deploy Site**.
6. Under **Site Configuration** → **Domain Management**, add your custom domain (e.g. `order.saffronandstone.com`).
7. Copy your Netlify URL and ensure it is saved in your Render backend `ALLOWED_ORIGIN` environment variable!

#### Deploying on GitHub Pages
1. Go to your GitHub repository **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, select **Deploy from a branch**.
3. Select branch `main` and folder `/ (root)`. Click **Save**.
4. Your site will be live at `https://<username>.github.io/<repository-name>/`.
5. Update `ALLOWED_ORIGIN` on Render with this GitHub Pages URL.

---

## 🛠️ Multi-Client Customization Guide (CONFIG)

To deploy this website for a new restaurant client, edit the centralized **`CONFIG`** object in `index.html` (lines 2202–2235). Everything updates automatically across the entire UI, UPI links, and WhatsApp messages:

```js
const CONFIG = {
  // 1. Identity & Branding
  shop:                  "Client Restaurant Name",     // Used in headers, alerts, and WhatsApp message headers
  name:                  "Client Restaurant Name",     // Full restaurant name

  // 2. UPI & Payment Settings (CRITICAL)
  upiId:                 "client_vpa@okhdfcbank",      // Merchant UPI ID (Must receive payments)
  payee:                 "Client Registered Payee",    // Exact account name registered with the UPI bank

  // 3. Contact & WhatsApp Integration
  whatsapp:              "919876543210",               // WhatsApp number with country code, NO '+' or spaces
  phone:                 "+91 98765 43210",            // Display phone for calling and footer
  email:                 "contact@clientrestaurant.com", // Contact email in footer and schema
  address:               "45 Market Road, Bengaluru",  // Physical address for pickup & footer

  // 4. Operating Hours
  hours: {
    open:                11,                           // Opening hour in 24-hr format (e.g. 11 for 11 AM)
    close:               23,                           // Closing hour in 24-hr format (e.g. 23 for 11 PM)
    display:             "Mon–Sun · 11:00 AM – 11:00 PM" // Display string across header & footer
  },

  // 5. Pricing, Fees & Taxes
  currency:              "₹",                          // Currency symbol
  minOrder:              250,                          // Minimum cart total required to checkout
  deliveryFee:           49,                           // Base delivery fee
  freeDeliveryThreshold: 500,                          // Subtotal required for free delivery
  taxRate:               0.05,                         // 0.05 = 5% GST

  // 6. Promotional Discounts
  couponCode:            "WELCOME10",                  // Active promotional coupon code
  couponDiscount:        0.10                          // 0.10 = 10% discount on subtotal
};
```

### Backend Menu Map Synchronization
When changing menu dishes and prices for a new client:
1. Update `MENU_ITEMS` array in [index.html](file:///c:/Users/Dell/Downloads/Restaurant/index.html).
2. Update the matching `MENU_ITEMS` price map in [backend/server.js](file:///c:/Users/Dell/Downloads/Restaurant/backend/server.js) to ensure server-side price validation matches the client's menu.

---

## 📜 Legal & Policy Pages

Both mandatory compliance pages are pre-built and styled in the project root:
- [privacy-policy.html](file:///c:/Users/Dell/Downloads/Restaurant/privacy-policy.html): Complete user data protection, collection, storage, and customer rights policy.
- [refund-policy.html](file:///c:/Users/Dell/Downloads/Restaurant/refund-policy.html): Clear perishable food cancellation terms (5-min window), UPI refund timelines, and damaged goods claim procedures.
- Both pages are linked in the main footer navigation under `Explore` and the bottom copyright bar.
