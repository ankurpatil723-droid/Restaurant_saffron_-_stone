const http = require('http');

async function req(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: { ...headers }
    };
    let data = null;
    if (body) {
      data = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(opts, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, raw: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const ADMIN_KEY = 'd677d08ecda554e2ed7f6f7274520751bf7bb7a8dfc19fa916725b59bc0eeb39';
  const DRIVER_KEY = 'driver_secret_key_restaurant_2026';

  console.log('=== TEST 1: POST /api/orders ===');
  // 1a. Invalid coordinate (lat out of range 195.0)
  let r = await req('/api/orders', 'POST', {}, {
    name: 'Aarav Sharma', phone: '9876543210', type: 'Delivery', address: 'Pune',
    destLat: 195.0, destLng: 73.89, items: [{ id: 's1', qty: 1 }]
  });
  console.log('1a. Invalid Lat (expect 400):', r.status, JSON.stringify(r.body));

  // 1b. Valid order with destLat & destLng
  r = await req('/api/orders', 'POST', {}, {
    name: 'Aarav Sharma', phone: '9876543210', type: 'Delivery', address: 'Koregaon Park, Pune',
    destLat: 18.5362, destLng: 73.8940, items: [{ id: 's1', qty: 2 }]
  });
  console.log('1b. Valid Order (expect 201 + trackingToken):', r.status, JSON.stringify(r.body));
  const orderId = r.body.orderId;
  const token = r.body.trackingToken;

  console.log('\n=== TEST 2: PATCH /api/orders/:orderId/status ===');
  // 2a. Unauthorized
  r = await req('/api/orders/' + orderId + '/status', 'PATCH', { 'x-admin-key': 'bad-key' }, { status: 'preparing' });
  console.log('2a. Bad admin key (expect 401):', r.status, JSON.stringify(r.body));

  // 2b. Invalid status
  r = await req('/api/orders/' + orderId + '/status', 'PATCH', { 'x-admin-key': ADMIN_KEY }, { status: 'flying' });
  console.log('2b. Invalid status "flying" (expect 400):', r.status, JSON.stringify(r.body));

  // 2c. Valid status to preparing
  r = await req('/api/orders/' + orderId + '/status', 'PATCH', { 'x-admin-key': ADMIN_KEY }, { status: 'preparing' });
  console.log('2c. Update to preparing (expect 200):', r.status, JSON.stringify(r.body));

  console.log('\n=== TEST 3: POST /api/driver/location ===');
  // 3a. Bad driver key
  r = await req('/api/driver/location', 'POST', { 'x-driver-key': 'bad-key' }, { orderId, lat: 18.52, lng: 73.85 });
  console.log('3a. Bad driver key (expect 401):', r.status, JSON.stringify(r.body));

  // 3b. Order is still "preparing", not "out_for_delivery"
  r = await req('/api/driver/location', 'POST', { 'x-driver-key': DRIVER_KEY }, { orderId, lat: 18.52, lng: 73.85 });
  console.log('3b. Reject while preparing (expect 400):', r.status, JSON.stringify(r.body));

  // 3c. Invalid coordinates
  r = await req('/api/driver/location', 'POST', { 'x-driver-key': DRIVER_KEY }, { orderId, lat: 'abc', lng: 73.85 });
  console.log('3c. Invalid coordinates (expect 400):', r.status, JSON.stringify(r.body));

  // Set order to out_for_delivery
  await req('/api/orders/' + orderId + '/status', 'PATCH', { 'x-admin-key': ADMIN_KEY }, { status: 'out_for_delivery' });

  // 3d. Valid location update
  r = await req('/api/driver/location', 'POST', { 'x-driver-key': DRIVER_KEY }, { orderId, lat: 18.5255, lng: 73.8620 });
  console.log('3d. Valid driver location when out_for_delivery (expect 200):', r.status, JSON.stringify(r.body));

  console.log('\n=== TEST 4: GET /api/track/:token ===');
  // 4a. Unknown token
  r = await req('/api/track/unknown-token-12345');
  console.log('4a. Unknown token (expect 404):', r.status, JSON.stringify(r.body));

  // 4b. Valid tracking token
  r = await req('/api/track/' + token);
  console.log('4b. Valid tracking token (expect 200):', r.status, JSON.stringify(r.body));
  const keys = Object.keys(r.body);
  console.log('Keys returned:', keys);
  const hasPrivateData = 'name' in r.body || 'phone' in r.body || 'address' in r.body || 'items' in r.body;
  console.log('Contains private data (must be false):', hasPrivateData);

  console.log('\n=== TEST 5: GET /api/orders (owner endpoint) ===');
  // 5a. Bad admin key
  r = await req('/api/orders', 'GET', { 'x-admin-key': 'bad-key' });
  console.log('5a. Bad admin key (expect 401):', r.status, JSON.stringify(r.body));

  // 5b. Valid admin key
  r = await req('/api/orders', 'GET', { 'x-admin-key': ADMIN_KEY });
  console.log('5b. Valid admin key (expect 200):', r.status, 'orders count:', r.body.count, 'latest orderId:', r.body.orders[0]?.order_id);

  console.log('\n=== ALL API ROUTE TESTS COMPLETE ===');
})();
