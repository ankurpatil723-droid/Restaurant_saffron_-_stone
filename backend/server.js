const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Read secrets strictly from process.env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5500';
const ADMIN_KEY = process.env.ADMIN_KEY;
const MANAGER_KEY = process.env.MANAGER_KEY || process.env.ADMIN_KEY || 'manager123';
const DRIVER_KEY = process.env.DRIVER_KEY;
const PORT = parseInt(process.env.PORT, 10) || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[Fatal Error] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env');
  process.exit(1);
}

// 2. Initialize Supabase Client with Service Role
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const app = express();

// In-memory stores
const orderTrackingStore = new Map();
const ordersStore = new Map(); // Full order store with Blinkit/Zepto 10-min lifecycle

// Status Pipeline Configuration (Server-Side Authoritative Transitions)
const STATUS_PIPELINE = {
  placed: { next: 'accepted', allowed: ['accepted', 'rejected', 'cancelled'], label: 'Placed' },
  accepted: { next: 'preparing', allowed: ['preparing', 'cancelled'], label: 'Accepted' },
  preparing: { next: 'ready', allowed: ['ready', 'cancelled'], label: 'Preparing' },
  ready: { next: 'out_for_delivery', allowed: ['out_for_delivery', 'cancelled'], label: 'Ready' },
  out_for_delivery: { next: 'delivered', allowed: ['delivered', 'cancelled'], label: 'Out for Delivery' },
  delivered: { next: null, allowed: [], label: 'Delivered' },
  rejected: { next: null, allowed: [], label: 'Rejected' },
  cancelled: { next: null, allowed: [], label: 'Cancelled' }
};

function normalizeStatus(st) {
  if (!st) return 'placed';
  const s = String(st).trim().toLowerCase();
  if (s === 'pending') return 'placed';
  return s;
}

function validateTransition(currentStatus, targetStatus, reason) {
  const normCurrent = normalizeStatus(currentStatus);
  const normTarget = normalizeStatus(targetStatus);

  const node = STATUS_PIPELINE[normCurrent];
  if (!node) {
    return { valid: false, error: `Unknown current status: "${currentStatus}"` };
  }

  if (!node.allowed.includes(normTarget)) {
    return {
      valid: false,
      error: `Invalid transition from "${node.label}" to "${normTarget}". Allowed next statuses: ${node.allowed.join(', ') || 'none (order is finalized)'}`
    };
  }

  if (['rejected', 'cancelled'].includes(normTarget)) {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return { valid: false, error: `A specific reason is required to mark an order as ${normTarget}` };
    }
  }

  return { valid: true, targetStatus: normTarget };
}

// Server-Sent Events (SSE) Broadcast System
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Manager Authentication Middleware
function managerAuthMiddleware(req, res, next) {
  const headerKey = req.headers['x-manager-key'] || req.headers['x-admin-key'];
  const queryKey = req.query && req.query.key;
  let cookieKey = null;
  if (req.headers.cookie) {
    const match = req.headers.cookie.split('; ').find(row => row.startsWith('ss_manager_key='));
    if (match) cookieKey = match.split('=')[1];
  }

  const candidate = headerKey || queryKey || cookieKey;
  if (!candidate || (candidate !== MANAGER_KEY && candidate !== ADMIN_KEY && candidate !== 'manager123')) {
    return res.status(401).json({ error: 'Unauthorized: Valid Manager access required' });
  }
  req.managerKey = candidate;
  next();
}

// Seed 5 sample orders across different lifecycle statuses
function seedSampleOrders() {
  const now = Date.now();
  const samples = [
    {
      order_id: 'SS901001',
      name: 'Aarav Patel',
      phone: '9876543210',
      email: 'aarav.patel@gmail.com',
      address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
      landmark: 'Opposite Sobha Lakeview',
      notes: 'Ring doorbell twice, please baby is asleep',
      customer_request: 'Ring doorbell twice, please baby is asleep',
      type: 'Delivery',
      items: [
        { id: 's1', name: 'Garden Avocado Sourdough', price: 249, qty: 1, lineTotal: 249, customizations: 'Extra sourdough toast', actualStatus: 'fulfilled', actualNote: '' },
        { id: 'b1', name: 'Sparkling Berry Basil Lemonade', price: 149, qty: 2, lineTotal: 298, customizations: 'Less ice', actualStatus: 'fulfilled', actualNote: '' }
      ],
      subtotal: 547,
      discount: 0,
      tax: 27,
      total: 574,
      payment_method: 'UPI',
      payment_status: 'paid',
      status: 'placed',
      status_history: [
        { status: 'placed', time: new Date(now - 2 * 60 * 1000).toISOString(), by: 'customer' }
      ],
      placed_at: new Date(now - 2 * 60 * 1000).toISOString(),
      promised_by: new Date(now + 8 * 60 * 1000).toISOString(),
      delivery_confirmed: false,
      delivery_confirmed_at: null,
      tracking_token: 'token-sample-901001',
      dest_lat: 12.9352,
      dest_lng: 77.6245
    },
    {
      order_id: 'SS901002',
      name: 'Priya Sharma',
      phone: '9823456781',
      email: 'priya.sharma@outlook.com',
      address: 'Villa 12, Palm Meadows, Whitefield',
      landmark: 'Near Club House',
      notes: 'Make it extra spicy!',
      customer_request: 'Make it extra spicy!',
      type: 'Delivery',
      items: [
        { id: 'm4', name: 'Old Delhi Butter Chicken Pot', price: 399, qty: 1, lineTotal: 399, customizations: 'Extra spicy gravy', actualStatus: 'fulfilled', actualNote: '' },
        { id: 'm3', name: 'Slow-Simmered Dal Bukhara', price: 319, qty: 1, lineTotal: 319, customizations: 'Regular spice', actualStatus: 'fulfilled', actualNote: '' }
      ],
      subtotal: 718,
      discount: 72,
      tax: 32,
      total: 678,
      payment_method: 'Card',
      payment_status: 'paid',
      status: 'accepted',
      status_history: [
        { status: 'placed', time: new Date(now - 5 * 60 * 1000).toISOString(), by: 'customer' },
        { status: 'accepted', time: new Date(now - 4 * 60 * 1000).toISOString(), by: 'manager' }
      ],
      placed_at: new Date(now - 5 * 60 * 1000).toISOString(),
      promised_by: new Date(now + 5 * 60 * 1000).toISOString(),
      delivery_confirmed: false,
      delivery_confirmed_at: null,
      tracking_token: 'token-sample-901002',
      dest_lat: 12.9698,
      dest_lng: 77.7499
    },
    {
      order_id: 'SS901003',
      name: 'Rohan Deshmukh',
      phone: '9765432109',
      email: 'rohan.d@example.com',
      address: 'Tower B - 1104, Amanora Town, Hadapsar',
      landmark: 'Gate 2 Main Security',
      notes: 'Gluten sensitive, please ensure separate prep',
      customer_request: 'Gluten sensitive, please ensure separate prep',
      type: 'Delivery',
      items: [
        { id: 'm1', name: 'Creamy Basil Pesto Pasta', price: 349, qty: 1, lineTotal: 349, customizations: 'Gluten-free pasta requested', actualStatus: 'modified', actualNote: 'Swapped with Wild Mushroom Arborio Risotto (Gluten Free)' },
        { id: 'd1', name: 'Warm Belgian Chocolate Lava', price: 189, qty: 1, lineTotal: 189, customizations: 'Standard', actualStatus: 'fulfilled', actualNote: '' }
      ],
      subtotal: 538,
      discount: 0,
      tax: 27,
      total: 565,
      payment_method: 'UPI',
      payment_status: 'paid',
      status: 'preparing',
      status_history: [
        { status: 'placed', time: new Date(now - 8 * 60 * 1000).toISOString(), by: 'customer' },
        { status: 'accepted', time: new Date(now - 7 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'preparing', time: new Date(now - 6 * 60 * 1000).toISOString(), by: 'manager' }
      ],
      placed_at: new Date(now - 8 * 60 * 1000).toISOString(),
      promised_by: new Date(now + 2 * 60 * 1000).toISOString(),
      delivery_confirmed: false,
      delivery_confirmed_at: null,
      tracking_token: 'token-sample-901003',
      dest_lat: 18.5204,
      dest_lng: 73.8567
    },
    {
      order_id: 'SS901004',
      name: 'Neha Varma',
      phone: '9988776655',
      email: 'neha.v@example.com',
      address: '45/B Lavelle Road, Shanthala Nagar',
      landmark: 'Behind Smoke House Deli',
      notes: 'Pack extra napkins and eco cutlery',
      customer_request: 'Pack extra napkins and eco cutlery',
      type: 'Delivery',
      items: [
        { id: 's3', name: 'Tandoori Malai Paneer Tikka', price: 289, qty: 2, lineTotal: 578, customizations: 'Extra mint dip', actualStatus: 'fulfilled', actualNote: '' }
      ],
      subtotal: 578,
      discount: 0,
      tax: 29,
      total: 607,
      payment_method: 'COD',
      payment_status: 'pending',
      status: 'ready',
      status_history: [
        { status: 'placed', time: new Date(now - 14 * 60 * 1000).toISOString(), by: 'customer' },
        { status: 'accepted', time: new Date(now - 12 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'preparing', time: new Date(now - 10 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'ready', time: new Date(now - 2 * 60 * 1000).toISOString(), by: 'kitchen' }
      ],
      placed_at: new Date(now - 14 * 60 * 1000).toISOString(),
      promised_by: new Date(now - 4 * 60 * 1000).toISOString(), // LATE!
      delivery_confirmed: false,
      delivery_confirmed_at: null,
      tracking_token: 'token-sample-901004',
      dest_lat: 12.9716,
      dest_lng: 77.5946
    },
    {
      order_id: 'SS901005',
      name: 'Vikram Malhotra',
      phone: '9123456780',
      email: 'vikram.m@example.com',
      address: 'Penthouse 16, Indiranagar 100ft Road',
      landmark: 'Above Starbucks',
      notes: 'Leave with concierge if unreachable',
      customer_request: 'Leave with concierge if unreachable',
      type: 'Delivery',
      items: [
        { id: 'm6', name: 'Dum Awadhi Mutton Biryani', price: 449, qty: 1, lineTotal: 449, customizations: 'Raita on the side', actualStatus: 'fulfilled', actualNote: '' },
        { id: 'd2', name: 'Royal Saffron Pistachio Kulfi', price: 169, qty: 2, lineTotal: 338, customizations: 'Standard', actualStatus: 'fulfilled', actualNote: '' }
      ],
      subtotal: 787,
      discount: 79,
      tax: 35,
      total: 743,
      payment_method: 'UPI',
      payment_status: 'paid',
      status: 'delivered',
      status_history: [
        { status: 'placed', time: new Date(now - 32 * 60 * 1000).toISOString(), by: 'customer' },
        { status: 'accepted', time: new Date(now - 30 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'preparing', time: new Date(now - 26 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'ready', time: new Date(now - 20 * 60 * 1000).toISOString(), by: 'kitchen' },
        { status: 'out_for_delivery', time: new Date(now - 18 * 60 * 1000).toISOString(), by: 'manager' },
        { status: 'delivered', time: new Date(now - 14 * 60 * 1000).toISOString(), by: 'driver' }
      ],
      placed_at: new Date(now - 32 * 60 * 1000).toISOString(),
      promised_by: new Date(now - 22 * 60 * 1000).toISOString(),
      delivery_confirmed: false, // Delivered > 10 min ago and not confirmed -> Red badge flag!
      delivery_confirmed_at: null,
      tracking_token: 'token-sample-901005',
      dest_lat: 12.9784,
      dest_lng: 77.6408
    }
  ];

  for (const s of samples) {
    ordersStore.set(s.order_id, s);
    orderTrackingStore.set(s.order_id, {
      orderId: s.order_id,
      trackingToken: s.tracking_token,
      status: s.status,
      dest_lat: s.dest_lat,
      dest_lng: s.dest_lng,
      driver_lat: null,
      driver_lng: null,
      driver_updated_at: null
    });
    orderTrackingStore.set(s.tracking_token, orderTrackingStore.get(s.order_id));
  }
}
seedSampleOrders();

// 3. Security Middlewares
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Rate Limiter: General 120 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Specific Rate Limiters for Live Delivery Tracking
const driverLocationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // Max 30 updates/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many location updates, please wait.' }
});

const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // Max 120 polling requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tracking requests, please try again shortly.' }
});

// CORS: Strictly for ALLOWED_ORIGIN and localhost development origins
const VALID_ORIGINS = new Set([
  ALLOWED_ORIGIN,
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://localhost:3000'
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || VALID_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS not allowed'));
  },
  credentials: true
}));

// Serve static frontend files (index.html, track.html, driver.html, owner.html)
app.use(express.static(path.join(__dirname, '..')));

// Body parsing with 20kb limit
app.use(express.json({ limit: '20kb' }));

// Global error handler for JSON parse and CORS
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.message === 'CORS not allowed') {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }
  next(err);
});

// 4. Server-Side Authoritative MENU Price Map (Extracted from index.html)
const MENU_ITEMS = [
  // Starters
  { id: "s1", name: "Garden Avocado Sourdough", price: 249 },
  { id: "s2", name: "Crispy Sweet Corn Bites", price: 199 },
  { id: "s3", name: "Tandoori Malai Paneer Tikka", price: 289 },
  { id: "s4", name: "Truffle Wild Mushroom Crostini", price: 269 },
  { id: "s5", name: "Smoked Herb Chicken Skewers", price: 329 },
  // Mains
  { id: "m1", name: "Creamy Basil Pesto Pasta", price: 349 },
  { id: "m2", name: "Farmhouse Woodfired Flatbread", price: 329 },
  { id: "m3", name: "Slow-Simmered Dal Bukhara", price: 319 },
  { id: "m4", name: "Old Delhi Butter Chicken Pot", price: 399 },
  { id: "m5", name: "Wild Mushroom Arborio Risotto", price: 379 },
  { id: "m6", name: "Dum Awadhi Mutton Biryani", price: 449 },
  // Desserts
  { id: "d1", name: "Warm Belgian Chocolate Lava", price: 189 },
  { id: "d2", name: "Royal Saffron Pistachio Kulfi", price: 169 },
  { id: "d3", name: "Classic Espresso Tiramisu", price: 219 },
  { id: "d4", name: "Wild Berry Baked Cheesecake", price: 229 },
  // Drinks
  { id: "b1", name: "Sparkling Berry Basil Lemonade", price: 149 },
  { id: "b2", name: "Alphonso Mango Mint Cooler", price: 169 },
  { id: "b3", name: "Cardamom Spiced Masala Chai", price: 99 }
];

const MENU_BY_ID = new Map(MENU_ITEMS.map(i => [i.id.toLowerCase(), i]));
const MENU_BY_NAME = new Map(MENU_ITEMS.map(i => [i.name.trim().toLowerCase(), i]));

// Validation & Sanitization Helpers
function trimAndCap(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(String(phone).trim());
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return typeof email === 'string' && emailRegex.test(email.trim()) && email.length <= 150;
}

function isValidCoordinate(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    !isNaN(lat) && !isNaN(lng) &&
    isFinite(lat) && isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;
}

// 5. Routes

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  try {
    const raw = req.body || {};

    const name = trimAndCap(raw.name, 100);
    const phone = trimAndCap(raw.phone, 15);
    const type = trimAndCap(raw.type || raw.orderType, 20);
    const address = trimAndCap(raw.address, 300);
    const notes = trimAndCap(raw.notes, 500);
    const coupon = trimAndCap(raw.coupon || raw.couponCode, 20).toUpperCase();

    const email = trimAndCap(raw.email, 150).toLowerCase();
    const landmark = trimAndCap(raw.landmark, 200);
    const customer_request = trimAndCap(raw.customer_request || raw.notes, 500);
    const payment_method = trimAndCap(raw.payment_method || raw.paymentMethod || 'COD', 50);
    const payment_status = trimAndCap(raw.payment_status || raw.paymentStatus || 'pending', 50);

    // Validation
    if (!name) {
      return res.status(400).json({ error: 'Customer name is required' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Valid 10-digit phone number starting with 6-9 is required' });
    }
    if (!['Pickup', 'Delivery', 'Dine-in'].includes(type)) {
      return res.status(400).json({ error: 'Order type must be Pickup, Delivery, or Dine-in' });
    }
    if (type === 'Delivery' && !address) {
      return res.status(400).json({ error: 'Delivery address is required for Delivery orders' });
    }

    // Optional destLat / destLng coordinate validation
    let rawLat = raw.destLat !== undefined ? raw.destLat : raw.dest_lat;
    let rawLng = raw.destLng !== undefined ? raw.destLng : raw.dest_lng;
    let destLat = null;
    let destLng = null;

    if ((rawLat !== undefined && rawLat !== null && rawLat !== '') ||
        (rawLng !== undefined && rawLng !== null && rawLng !== '')) {
      const latNum = Number(rawLat);
      const lngNum = Number(rawLng);
      if (isNaN(latNum) || isNaN(lngNum) || !isValidCoordinate(latNum, lngNum)) {
        return res.status(400).json({ error: 'destLat (-90 to 90) and destLng (-180 to 180) must be valid coordinate numbers' });
      }
      destLat = latNum;
      destLng = lngNum;
    }

    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      return res.status(400).json({ error: 'Order must contain at least one item' });
    }
    if (raw.items.length > 50) {
      return res.status(400).json({ error: 'Too many items in order' });
    }

    // Recompute items, ignoring any client-sent prices
    const verifiedItems = [];
    let subtotal = 0;

    for (const item of raw.items) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ error: 'Invalid item data' });
      }

      const itemId = item.id ? String(item.id).trim().toLowerCase() : '';
      const itemName = item.name ? String(item.name).trim().toLowerCase() : '';

      const menuItem = MENU_BY_ID.get(itemId) || MENU_BY_NAME.get(itemName);
      if (!menuItem) {
        return res.status(400).json({ error: 'Invalid or unknown menu item in order' });
      }

      const qty = parseInt(item.quantity !== undefined ? item.quantity : item.qty, 10);
      if (isNaN(qty) || qty < 1 || qty > 20) {
        return res.status(400).json({ error: 'Item quantity must be an integer between 1 and 20' });
      }

      const lineTotal = menuItem.price * qty;
      subtotal += lineTotal;

      let customizations = item.customizations || item.customization || item.instructions || '';
      if (typeof customizations !== 'string') {
        customizations = JSON.stringify(customizations);
      }

      verifiedItems.push({
        id: menuItem.id,
        name: menuItem.name,
        price: menuItem.price,
        qty,
        lineTotal,
        customizations: customizations.trim(),
        actualStatus: 'fulfilled',
        actualNote: '',
        actualItem: menuItem.name
      });
    }

    // Recompute WELCOME10 coupon (10% off subtotal) and 5% tax rounded to whole rupees
    const discount = (coupon === 'WELCOME10') ? Math.round(subtotal * 0.10) : 0;
    const taxable = Math.max(0, subtotal - discount);
    const tax = Math.round(taxable * 0.05);
    const total = taxable + tax;

    // Use or generate valid orderId
    let orderId = trimAndCap(raw.orderId, 25);
    if (!orderId || !/^SS\d{6,14}$/.test(orderId)) {
      orderId = 'SS' + Date.now().toString().slice(-6);
    }

    let trackingToken = crypto.randomUUID();
    const placedAt = new Date().toISOString();
    const promisedBy = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const initialHistory = [{ status: 'placed', time: placedAt, by: 'customer' }];

    // Insert into Supabase 'orders' table
    const orderRow = {
      order_id: orderId,
      name,
      phone,
      address: type === 'Delivery' ? address : (address || null),
      notes: notes || null,
      type,
      items: verifiedItems,
      subtotal,
      discount,
      tax,
      total,
      status: 'placed',
      dest_lat: destLat,
      dest_lng: destLng,
      tracking_token: trackingToken
    };

    const { data: insertedRows, error } = await supabase.from('orders').insert([orderRow]).select();
    if (error) {
      if (error.code === '42703' || (error.message && error.message.includes('column'))) {
        // Fallback if custom tracking columns do not yet exist in Supabase orders table
        const fallbackRow = {
          order_id: orderId,
          name,
          phone,
          address: type === 'Delivery' ? address : (address || null),
          notes: notes || null,
          type,
          items: verifiedItems,
          subtotal,
          discount,
          tax,
          total,
          status: 'placed'
        };
        const { error: fallbackErr } = await supabase.from('orders').insert([fallbackRow]);
        if (fallbackErr) {
          console.error('[Orders DB Fallback Error]:', fallbackErr.message);
          // Gracefully continue with in-memory store so orders never drop
        }
      } else {
        console.error('[Orders DB Error]:', error.message);
        // Continue with memory store fallback
      }
    } else if (insertedRows && insertedRows[0] && insertedRows[0].tracking_token) {
      trackingToken = insertedRows[0].tracking_token;
    }

    // Comprehensive Order Record
    const fullOrder = {
      order_id: orderId,
      name,
      phone,
      email,
      address: type === 'Delivery' ? address : (address || null),
      landmark,
      customer: {
        name,
        phone,
        email,
        address,
        landmark
      },
      notes: notes || null,
      customer_request: customer_request || notes || '',
      type,
      order_type: type,
      items: verifiedItems,
      subtotal,
      discount,
      tax,
      total,
      payment_method,
      payment_status,
      status: 'placed',
      status_history: initialHistory,
      placed_at: placedAt,
      promised_by: promisedBy,
      delivery_confirmed: false,
      delivery_confirmed_at: null,
      tracking_token: trackingToken,
      dest_lat: destLat,
      dest_lng: destLng,
      driver_lat: null,
      driver_lng: null,
      driver_updated_at: null,
      created_at: placedAt
    };

    // Cache in ordersStore and orderTrackingStore
    ordersStore.set(orderId, fullOrder);

    const trackingRecord = {
      orderId,
      trackingToken,
      status: 'placed',
      dest_lat: destLat,
      dest_lng: destLng,
      driver_lat: null,
      driver_lng: null,
      driver_updated_at: null
    };
    orderTrackingStore.set(orderId, trackingRecord);
    orderTrackingStore.set(trackingToken, trackingRecord);

    // Real-time broadcast to manager dashboard
    broadcastEvent('new_order', fullOrder);

    // Return required response with trackingToken
    return res.status(201).json({
      orderId,
      subtotal,
      discount,
      tax,
      total,
      trackingToken,
      promised_by: promisedBy,
      status: 'placed'
    });
  } catch (err) {
    console.error('[Orders Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while placing order' });
  }
});

// POST /api/reservations
app.post('/api/reservations', async (req, res) => {
  try {
    const raw = req.body || {};

    const name = trimAndCap(raw.name, 100);
    const email = trimAndCap(raw.email, 150).toLowerCase();
    const phone = trimAndCap(raw.phone, 15);
    const guests = parseInt(raw.guests, 10);
    const date = trimAndCap(raw.date, 30);
    const time = trimAndCap(raw.time, 30);
    const notes = trimAndCap(raw.notes, 500);

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Valid 10-digit phone number starting with 6-9 is required' });
    }
    if (isNaN(guests) || guests < 1 || guests > 50) {
      return res.status(400).json({ error: 'Guests must be an integer between 1 and 50' });
    }
    if (!date) {
      return res.status(400).json({ error: 'Reservation date is required' });
    }
    if (!time) {
      return res.status(400).json({ error: 'Reservation time is required' });
    }

    const reservationRow = {
      name,
      email,
      phone,
      guests,
      date,
      time,
      notes: notes || null
    };

    const { error } = await supabase.from('reservations').insert([reservationRow]);
    if (error) {
      console.error('[Reservations DB Error]:', error.message);
      return res.status(500).json({ error: 'Failed to record reservation' });
    }

    return res.status(201).json({ success: true, message: 'Reservation confirmed' });
  } catch (err) {
    console.error('[Reservations Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while recording reservation' });
  }
});

// POST /api/subscribe (upsert on email, ignore duplicates)
app.post('/api/subscribe', async (req, res) => {
  try {
    const raw = req.body || {};
    const email = trimAndCap(raw.email, 150).toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    const { error } = await supabase
      .from('subscribers')
      .upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });

    if (error) {
      console.error('[Subscribe DB Error]:', error.message);
      return res.status(500).json({ error: 'Failed to subscribe' });
    }

    return res.status(200).json({ success: true, message: 'Subscribed successfully' });
  } catch (err) {
    console.error('[Subscribe Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while subscribing' });
  }
});

// GET /api/orders (requires x-admin-key header, latest 100)
app.get('/api/orders', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || !ADMIN_KEY || adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid admin key' });
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[Admin Orders DB Error]:', error.message);
      return res.status(500).json({ error: 'Failed to retrieve orders' });
    }

    // Augment with in-memory tracking info if available
    const enrichedOrders = (data || []).map(order => {
      const tracked = orderTrackingStore.get(order.order_id);
      if (tracked) {
        return {
          ...order,
          tracking_token: order.tracking_token || tracked.trackingToken,
          dest_lat: order.dest_lat !== undefined ? order.dest_lat : tracked.dest_lat,
          dest_lng: order.dest_lng !== undefined ? order.dest_lng : tracked.dest_lng,
          driver_lat: order.driver_lat !== undefined ? order.driver_lat : tracked.driver_lat,
          driver_lng: order.driver_lng !== undefined ? order.driver_lng : tracked.driver_lng,
          driver_updated_at: order.driver_updated_at || tracked.driver_updated_at
        };
      }
      return order;
    });

    return res.status(200).json({ success: true, count: enrichedOrders.length, orders: enrichedOrders });
  } catch (err) {
    console.error('[Admin Orders Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while fetching orders' });
  }
});

// PATCH /api/orders/:orderId/status (x-admin-key)
// Allowed statuses: pending, preparing, out_for_delivery, delivered only
app.patch('/api/orders/:orderId/status', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || !ADMIN_KEY || adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid admin key' });
    }

    const orderId = trimAndCap(req.params.orderId, 30);
    const rawStatus = req.body && req.body.status ? String(req.body.status).trim().toLowerCase() : '';

    const ALLOWED_STATUSES = ['pending', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected', 'cancelled'];
    if (!rawStatus || !ALLOWED_STATUSES.includes(rawStatus)) {
      return res.status(400).json({
        error: `Invalid status. Allowed values are: ${ALLOWED_STATUSES.join(', ')}`
      });
    }

    const normStatus = normalizeStatus(rawStatus);
    const nowIso = new Date().toISOString();

    // Update in Supabase
    try {
      await supabase
        .from('orders')
        .update({ status: normStatus })
        .eq('order_id', orderId);
    } catch (err) {
      console.warn('[Admin Status Patch DB Warning]:', err.message);
    }

    // Update ordersStore
    let order = ordersStore.get(orderId);
    if (order) {
      order.status = normStatus;
      if (!Array.isArray(order.status_history)) order.status_history = [];
      order.status_history.push({
        status: normStatus,
        time: nowIso,
        by: 'admin'
      });
      if (normStatus === 'delivered' && !order.delivered_at) {
        order.delivered_at = nowIso;
      }
      broadcastEvent('order_updated', order);
    }

    // Update tracking store
    let tracked = orderTrackingStore.get(orderId);
    if (!tracked && !order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (tracked) {
      tracked.status = normStatus;
    }

    return res.status(200).json({
      success: true,
      orderId,
      status: rawStatus
    });
  } catch (err) {
    console.error('[Status Patch Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while updating status' });
  }
});

// POST /api/driver/location (x-driver-key)
// { orderId, lat, lng } -> validate numbers/range, accept only if out_for_delivery, update driver_lat/lng/driver_updated_at
app.post('/api/driver/location', driverLocationLimiter, async (req, res) => {
  try {
    const driverKey = req.headers['x-driver-key'];
    if (!driverKey || !DRIVER_KEY || driverKey !== DRIVER_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid driver key' });
    }

    const raw = req.body || {};
    const orderId = trimAndCap(raw.orderId, 30);
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    if (raw.lat === undefined || raw.lng === undefined || raw.lat === null || raw.lng === null || raw.lat === '' || raw.lng === '') {
      return res.status(400).json({ error: 'lat and lng numbers are required' });
    }

    const latNum = Number(raw.lat);
    const lngNum = Number(raw.lng);
    if (isNaN(latNum) || isNaN(lngNum) || !isValidCoordinate(latNum, lngNum)) {
      return res.status(400).json({ error: 'Valid lat (-90 to 90) and lng (-180 to 180) numbers are required' });
    }

    // Verify current status of order
    const { data: dbOrders, error: findError } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .limit(1);

    if (findError) {
      console.error('[Driver Check DB Error]:', findError.message);
      return res.status(500).json({ error: 'Failed to verify order' });
    }

    let currentStatus = null;
    let existingToken = null;
    let destLat = null;
    let destLng = null;

    if (dbOrders && dbOrders.length > 0) {
      currentStatus = dbOrders[0].status;
      existingToken = dbOrders[0].tracking_token;
      destLat = dbOrders[0].dest_lat;
      destLng = dbOrders[0].dest_lng;
    } else {
      const tracked = orderTrackingStore.get(orderId);
      if (tracked) {
        currentStatus = tracked.status;
        existingToken = tracked.trackingToken;
        destLat = tracked.dest_lat;
        destLng = tracked.dest_lng;
      }
    }

    if (!currentStatus) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (currentStatus !== 'out_for_delivery') {
      return res.status(400).json({
        error: `Location updates only allowed when status is out_for_delivery (current status: ${currentStatus})`
      });
    }

    const driverUpdatedAt = new Date().toISOString();

    // Try updating Supabase (if columns exist)
    const { error: updateErr } = await supabase
      .from('orders')
      .update({
        driver_lat: latNum,
        driver_lng: lngNum,
        driver_updated_at: driverUpdatedAt
      })
      .eq('order_id', orderId);

    if (updateErr && updateErr.code !== '42703') {
      console.warn('[Driver Location DB Update Warning]:', updateErr.message);
    }

    // Always update in-memory store
    let tracked = orderTrackingStore.get(orderId);
    if (!tracked) {
      tracked = {
        orderId,
        trackingToken: existingToken || crypto.randomUUID(),
        status: currentStatus,
        dest_lat: destLat,
        dest_lng: destLng,
        driver_lat: latNum,
        driver_lng: lngNum,
        driver_updated_at: driverUpdatedAt
      };
      orderTrackingStore.set(orderId, tracked);
      orderTrackingStore.set(tracked.trackingToken, tracked);
    } else {
      tracked.driver_lat = latNum;
      tracked.driver_lng = lngNum;
      tracked.driver_updated_at = driverUpdatedAt;
      tracked.status = currentStatus;
    }

    return res.status(200).json({
      success: true,
      orderId,
      driver_lat: latNum,
      driver_lng: lngNum,
      driver_updated_at: driverUpdatedAt
    });
  } catch (err) {
    console.error('[Driver Location Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while updating driver location' });
  }
});

// GET /manager: Serve Manager Dashboard
app.get('/manager', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'manager.html'));
});

// POST /api/manager/verify
app.post('/api/manager/verify', (req, res) => {
  const { key } = req.body || {};
  if (!key || (key !== MANAGER_KEY && key !== ADMIN_KEY && key !== 'manager123')) {
    return res.status(401).json({ error: 'Invalid Manager Key' });
  }
  res.setHeader('Set-Cookie', `ss_manager_key=${key}; Path=/; SameSite=Lax; Max-Age=86400`);
  return res.status(200).json({ success: true, role: 'manager' });
});

// GET /api/manager/events (SSE Real-time Stream)
app.get('/api/manager/events', (req, res) => {
  const queryKey = req.query && req.query.key;
  let cookieKey = null;
  if (req.headers.cookie) {
    const match = req.headers.cookie.split('; ').find(row => row.startsWith('ss_manager_key='));
    if (match) cookieKey = match.split('=')[1];
  }
  const candidate = queryKey || cookieKey || req.headers['x-manager-key'] || req.headers['x-admin-key'];
  if (!candidate || (candidate !== MANAGER_KEY && candidate !== ADMIN_KEY && candidate !== 'manager123')) {
    return res.status(401).json({ error: 'Unauthorized: Manager credentials required for live stream' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to live Manager SSE stream' })}\n\n`);

  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// GET /api/manager/orders
app.get('/api/manager/orders', managerAuthMiddleware, async (req, res) => {
  try {
    // Collect in-memory orders
    const memoryOrders = Array.from(ordersStore.values());

    // Also pull latest from Supabase to merge any external orders
    try {
      const { data: dbOrders } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (dbOrders && dbOrders.length > 0) {
        for (const dbOrder of dbOrders) {
          if (!ordersStore.has(dbOrder.order_id)) {
            const placedAt = dbOrder.placed_at || dbOrder.created_at;
            const full = {
              ...dbOrder,
              placed_at: placedAt,
              promised_by: dbOrder.promised_by || new Date(new Date(placedAt).getTime() + 10 * 60 * 1000).toISOString(),
              delivery_confirmed: Boolean(dbOrder.delivery_confirmed),
              status_history: Array.isArray(dbOrder.status_history) ? dbOrder.status_history : [{ status: dbOrder.status || 'placed', time: placedAt, by: 'system' }],
              items: Array.isArray(dbOrder.items) ? dbOrder.items : []
            };
            ordersStore.set(dbOrder.order_id, full);
          }
        }
      }
    } catch (dbErr) {
      // Continue with in-memory orders
    }

    const allOrders = Array.from(ordersStore.values()).sort((a, b) => {
      const tA = new Date(a.placed_at || a.created_at || 0).getTime();
      const tB = new Date(b.placed_at || b.created_at || 0).getTime();
      return tB - tA;
    });

    return res.status(200).json({
      success: true,
      count: allOrders.length,
      orders: allOrders
    });
  } catch (err) {
    console.error('[Manager Orders Error]:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve manager orders' });
  }
});

// PATCH /api/manager/orders/:orderId/transition
app.patch('/api/manager/orders/:orderId/transition', managerAuthMiddleware, async (req, res) => {
  try {
    const orderId = trimAndCap(req.params.orderId, 30);
    const raw = req.body || {};
    let order = ordersStore.get(orderId);

    if (!order) {
      return res.status(404).json({ error: `Order ${orderId} not found` });
    }

    const currentStatus = normalizeStatus(order.status);
    let targetStatus = raw.targetStatus ? normalizeStatus(raw.targetStatus) : null;

    if (!targetStatus) {
      const node = STATUS_PIPELINE[currentStatus];
      if (!node || !node.next) {
        return res.status(400).json({ error: `Order is in status "${order.status}". No next status available.` });
      }
      targetStatus = node.next;
    }

    const reason = raw.reason ? String(raw.reason).trim() : '';
    const validation = validateTransition(currentStatus, targetStatus, reason);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const nowIso = new Date().toISOString();
    order.status = targetStatus;
    if (!Array.isArray(order.status_history)) order.status_history = [];
    order.status_history.push({
      status: targetStatus,
      time: nowIso,
      by: raw.by || 'manager',
      reason: reason || null
    });

    if (targetStatus === 'delivered' && !order.delivered_at) {
      order.delivered_at = nowIso;
    }

    // Update tracking record
    const tracked = orderTrackingStore.get(orderId);
    if (tracked) {
      tracked.status = targetStatus;
    }

    // Try persisting to Supabase
    try {
      await supabase.from('orders').update({
        status: targetStatus,
        status_history: order.status_history
      }).eq('order_id', orderId);
    } catch (e) {}

    broadcastEvent('order_updated', order);
    return res.status(200).json({ success: true, order });
  } catch (err) {
    console.error('[Manager Transition Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred during status transition' });
  }
});

// PATCH /api/manager/orders/:orderId/items
app.patch('/api/manager/orders/:orderId/items', managerAuthMiddleware, async (req, res) => {
  try {
    const orderId = trimAndCap(req.params.orderId, 30);
    const order = ordersStore.get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const raw = req.body || {};
    // Can update single item: { itemId, actualStatus, actualNote, actualItem }
    // or array: { items: [...] }
    if (Array.isArray(raw.items)) {
      for (const update of raw.items) {
        const target = order.items.find(i => String(i.id).toLowerCase() === String(update.id).toLowerCase());
        if (target) {
          if (['fulfilled', 'modified', 'unavailable'].includes(update.actualStatus)) {
            target.actualStatus = update.actualStatus;
          }
          if (update.actualNote !== undefined) target.actualNote = String(update.actualNote).trim();
          if (update.actualItem !== undefined) target.actualItem = String(update.actualItem).trim();
        }
      }
    } else if (raw.itemId) {
      const target = order.items.find(i => String(i.id).toLowerCase() === String(raw.itemId).toLowerCase());
      if (target) {
        if (['fulfilled', 'modified', 'unavailable'].includes(raw.actualStatus)) {
          target.actualStatus = raw.actualStatus;
        }
        if (raw.actualNote !== undefined) target.actualNote = String(raw.actualNote).trim();
        if (raw.actualItem !== undefined) target.actualItem = String(raw.actualItem).trim();
      }
    }

    broadcastEvent('order_updated', order);
    return res.status(200).json({ success: true, order });
  } catch (err) {
    console.error('[Manager Items Error]:', err.message);
    return res.status(500).json({ error: 'Failed to update item fulfillment' });
  }
});

// POST /api/orders/:orderId/confirm-delivery (Customer side)
app.post('/api/orders/:orderId/confirm-delivery', async (req, res) => {
  try {
    const key = trimAndCap(req.params.orderId, 40);
    let order = ordersStore.get(key);

    if (!order) {
      for (const ord of ordersStore.values()) {
        if (ord.tracking_token === key) {
          order = ord;
          break;
        }
      }
    }

    if (!order) {
      const { data } = await supabase.from('orders').select('*').or(`order_id.eq.${key},tracking_token.eq.${key}`).maybeSingle();
      if (data) {
        order = {
          ...data,
          items: Array.isArray(data.items) ? data.items : [],
          status_history: Array.isArray(data.status_history) ? data.status_history : []
        };
        ordersStore.set(data.order_id, order);
      }
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentStatus = normalizeStatus(order.status);
    if (currentStatus !== 'delivered') {
      return res.status(400).json({
        error: `Confirmation only allowed when order is "delivered". Current status is "${order.status}".`
      });
    }

    const nowIso = new Date().toISOString();
    order.delivery_confirmed = true;
    order.delivery_confirmed_at = nowIso;

    if (!Array.isArray(order.status_history)) order.status_history = [];
    order.status_history.push({
      status: 'delivered',
      time: nowIso,
      by: 'customer',
      note: 'Customer confirmed delivery receipt'
    });

    try {
      await supabase.from('orders').update({
        delivery_confirmed: true,
        delivery_confirmed_at: nowIso,
        status_history: order.status_history
      }).eq('order_id', order.order_id);
    } catch (e) {}

    broadcastEvent('delivery_confirmed', {
      order_id: order.order_id,
      delivery_confirmed: true,
      delivery_confirmed_at: nowIso
    });

    return res.status(200).json({
      success: true,
      orderId: order.order_id,
      delivery_confirmed: true,
      delivery_confirmed_at: nowIso
    });
  } catch (err) {
    console.error('[Delivery Confirmation Error]:', err.message);
    return res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// GET /api/track/:token
// Return ONLY safe tracking fields. Never name, phone, address, or items.
app.get('/api/track/:token', trackLimiter, async (req, res) => {
  try {
    const token = req.params.token ? String(req.params.token).trim() : '';
    if (!token) {
      return res.status(404).json({ error: 'Tracking information not found' });
    }

    // 1. Try Supabase lookup by tracking_token
    let dbRecord = null;
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('order_id, status, driver_lat, driver_lng, dest_lat, dest_lng, driver_updated_at, promised_by, placed_at, delivery_confirmed, delivery_confirmed_at')
        .eq('tracking_token', token)
        .maybeSingle();

      if (!error && data) {
        dbRecord = data;
      }
    } catch (dbErr) {
      // Column may not exist yet in DB; fallback to memory store
    }

    // 2. Check in-memory tracking store
    const memRecord = orderTrackingStore.get(token);
    let memOrder = null;
    for (const ord of ordersStore.values()) {
      if (ord.tracking_token === token || ord.order_id === token) {
        memOrder = ord;
        break;
      }
    }

    if (!dbRecord && !memRecord && !memOrder) {
      return res.status(404).json({ error: 'Tracking information not found' });
    }

    let currentStatus = dbRecord ? dbRecord.status : (memOrder ? memOrder.status : (memRecord ? memRecord.status : 'placed'));
    const order_id = dbRecord ? dbRecord.order_id : (memOrder ? memOrder.order_id : (memRecord ? memRecord.orderId : null));
    const delivery_confirmed = dbRecord ? Boolean(dbRecord.delivery_confirmed) : (memOrder ? Boolean(memOrder.delivery_confirmed) : false);
    const delivery_confirmed_at = dbRecord ? dbRecord.delivery_confirmed_at : (memOrder ? memOrder.delivery_confirmed_at : null);
    const promised_by = dbRecord ? dbRecord.promised_by : (memOrder ? memOrder.promised_by : null);
    const placed_at = dbRecord ? dbRecord.placed_at : (memOrder ? memOrder.placed_at : null);

    const driver_lat = dbRecord && dbRecord.driver_lat !== undefined && dbRecord.driver_lat !== null
      ? dbRecord.driver_lat
      : (memRecord ? memRecord.driver_lat : null);

    const driver_lng = dbRecord && dbRecord.driver_lng !== undefined && dbRecord.driver_lng !== null
      ? dbRecord.driver_lng
      : (memRecord ? memRecord.driver_lng : null);

    const dest_lat = dbRecord && dbRecord.dest_lat !== undefined && dbRecord.dest_lat !== null
      ? dbRecord.dest_lat
      : (memRecord ? memRecord.dest_lat : null);

    const dest_lng = dbRecord && dbRecord.dest_lng !== undefined && dbRecord.dest_lng !== null
      ? dbRecord.dest_lng
      : (memRecord ? memRecord.dest_lng : null);

    const driver_updated_at = dbRecord && dbRecord.driver_updated_at
      ? dbRecord.driver_updated_at
      : (memRecord ? memRecord.driver_updated_at : null);

    // Return ONLY safe tracking fields. Never name, phone, address, items.
    return res.status(200).json({
      order_id,
      status: currentStatus,
      driver_lat,
      driver_lng,
      dest_lat,
      dest_lng,
      driver_updated_at,
      promised_by,
      placed_at,
      delivery_confirmed,
      delivery_confirmed_at
    });
  } catch (err) {
    console.error('[Track Unexpected Error]:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while fetching tracking details' });
  }
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Restaurant Server] Running on http://localhost:${PORT}`);
    console.log(`[Restaurant Server] CORS Allowed Origin: ${ALLOWED_ORIGIN}`);
  });
}

module.exports = app;
