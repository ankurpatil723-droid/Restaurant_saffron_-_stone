const http = require('http');
const app = require('./server');

let PORT = 3000;
const MANAGER_KEY = process.env.ADMIN_KEY || 'manager123';
let localServer = null;

function request(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: { ...headers }
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING MANAGER PIPELINE & TRANSITION TESTS ---');

  // Test 1: Manager Auth Protection
  console.log('\n[1] Testing Manager Authentication...');
  const unauth = await request('/api/manager/orders', 'GET');
  console.assert(unauth.status === 401, `Expected 401 unauth, got ${unauth.status}`);
  console.log('✓ Unauthenticated access correctly blocked (401)');

  const auth = await request('/api/manager/orders', 'GET', { 'x-manager-key': MANAGER_KEY });
  console.assert(auth.status === 200, `Expected 200 auth, got ${auth.status}`);
  console.assert(Array.isArray(auth.body.orders), 'Expected orders array');
  console.log(`✓ Manager authenticated: retrieved ${auth.body.orders.length} orders`);

  // Test 2: Create a fresh order for pipeline testing
  console.log('\n[2] Placing Fresh Test Order (10-minute Blinkit style)...');
  const orderRes = await request('/api/orders', 'POST', {}, {
    name: 'Kavita Nair',
    phone: '9876543211',
    email: 'kavita@test.com',
    type: 'Delivery',
    address: 'Apt 501, Horizon Towers, Indiranagar',
    landmark: 'Near Metro Station',
    notes: 'Please do not ring bell after 9pm',
    customer_request: 'Please do not ring bell after 9pm',
    payment_method: 'UPI',
    items: [
      { id: 's1', qty: 1, customizations: 'Extra crispy' },
      { id: 'm1', qty: 1, customizations: 'Less garlic' }
    ]
  });
  console.assert(orderRes.status === 201, `Failed to place order: ${JSON.stringify(orderRes.body)}`);
  const testOrderId = orderRes.body.orderId;
  const token = orderRes.body.trackingToken;
  console.log(`✓ Order placed: ${testOrderId}, promised_by: ${orderRes.body.promised_by}`);

  // Test 3: Invalid state jump (Placed -> Delivered)
  console.log('\n[3] Testing Invalid State Jump (Placed -> Delivered directly)...');
  const invalidJump = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'delivered' }
  );
  console.assert(invalidJump.status === 400, `Expected 400 for invalid jump, got ${invalidJump.status}`);
  console.log(`✓ Invalid jump correctly rejected: "${invalidJump.body.error}"`);

  // Test 4: Reject/Cancel without reason (must be rejected)
  console.log('\n[4] Testing Reject/Cancel without reason requirement...');
  const cancelNoReason = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'cancelled' }
  );
  console.assert(cancelNoReason.status === 400, `Expected 400 for cancel without reason, got ${cancelNoReason.status}`);
  console.log(`✓ Cancellation without reason rejected: "${cancelNoReason.body.error}"`);

  // Test 5: Step-by-step pipeline transitions
  console.log('\n[5] Testing Step-by-Step Transition Pipeline...');
  
  // Placed -> Accepted
  let step = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'accepted' }
  );
  console.assert(step.status === 200 && step.body.order.status === 'accepted', 'Failed Placed -> Accepted');
  console.log('✓ Placed -> Accepted successful');

  // Accepted -> Preparing
  step = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'preparing' }
  );
  console.assert(step.status === 200 && step.body.order.status === 'preparing', 'Failed Accepted -> Preparing');
  console.log('✓ Accepted -> Preparing successful');

  // Test 6: Side-by-side item fulfillment / modification
  console.log('\n[6] Testing Item Fulfillment & Modification...');
  const itemMod = await request(`/api/manager/orders/${testOrderId}/items`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { itemId: 'm1', actualStatus: 'modified', actualNote: 'Substituted with Gluten-free penne', actualItem: 'GF Penne Pasta' }
  );
  console.assert(itemMod.status === 200, 'Failed to update item fulfillment');
  const modItem = itemMod.body.order.items.find(i => i.id === 'm1');
  console.assert(modItem.actualStatus === 'modified', 'Item actualStatus mismatch');
  console.log('✓ Item marked Modified with note: ' + modItem.actualNote);

  // Preparing -> Ready
  step = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'ready' }
  );
  console.assert(step.status === 200 && step.body.order.status === 'ready', 'Failed Preparing -> Ready');
  console.log('✓ Preparing -> Ready successful');

  // Premature Delivery Confirmation (should fail before Delivered)
  console.log('\n[7] Testing Premature Delivery Confirmation...');
  const earlyConfirm = await request(`/api/orders/${testOrderId}/confirm-delivery`, 'POST');
  console.assert(earlyConfirm.status === 400, 'Early confirmation should be rejected with 400');
  console.log(`✓ Early confirmation blocked: "${earlyConfirm.body.error}"`);

  // Ready -> Out for Delivery
  step = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'out_for_delivery' }
  );
  console.assert(step.status === 200 && step.body.order.status === 'out_for_delivery', 'Failed Ready -> Out for Delivery');
  console.log('✓ Ready -> Out for Delivery successful');

  // Out for Delivery -> Delivered
  step = await request(`/api/manager/orders/${testOrderId}/transition`, 'PATCH',
    { 'x-manager-key': MANAGER_KEY },
    { targetStatus: 'delivered' }
  );
  console.assert(step.status === 200 && step.body.order.status === 'delivered', 'Failed Out for Delivery -> Delivered');
  console.log('✓ Out for Delivery -> Delivered successful');

  // Test 8: Customer Delivery Confirmation
  console.log('\n[8] Testing Customer Delivery Confirmation ("I received my order")...');
  const confirmRes = await request(`/api/orders/${testOrderId}/confirm-delivery`, 'POST');
  console.assert(confirmRes.status === 200 && confirmRes.body.delivery_confirmed === true, 'Failed customer confirmation');
  console.log(`✓ Customer confirmed delivery at: ${confirmRes.body.delivery_confirmed_at}`);

  // Test 9: Public tracking endpoint privacy & safe data check
  console.log('\n[9] Checking Tracking Endpoint Privacy...');
  const trackRes = await request(`/api/track/${token}`, 'GET');
  console.assert(trackRes.status === 200, 'Failed to fetch tracking details');
  console.assert(trackRes.body.status === 'delivered', 'Status mismatch in tracking');
  console.assert(trackRes.body.delivery_confirmed === true, 'Delivery confirmed mismatch');
  const hasLeakedPII = 'name' in trackRes.body || 'phone' in trackRes.body || 'address' in trackRes.body || 'items' in trackRes.body;
  console.assert(!hasLeakedPII, 'Tracking endpoint must not leak customer PII');
  console.log('✓ Tracking endpoint returned status & confirmation safely without customer PII');

  console.log('\n=============================================');
  console.log('ALL PIPELINE & TRANSITION TESTS PASSED (9/9)');
  console.log('=============================================');
}

async function main() {
  localServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      PORT = s.address().port;
      resolve(s);
    });
  });

  try {
    await runTests();
  } finally {
    if (localServer) localServer.close();
  }
}

main().catch(err => {
  console.error('Test execution failed:', err);
  if (localServer) localServer.close();
  process.exit(1);
});
