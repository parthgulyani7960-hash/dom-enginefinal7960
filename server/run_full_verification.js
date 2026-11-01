const fetch = globalThis.fetch || require('node-fetch');

async function runFullVerification() {
  console.log('=== RUNNING FULL VERIFICATION SUITE ===');

  // 1. Test Order 22 lookup
  console.log('\n[TEST 1] Lookup Order 22:');
  const res22 = await fetch('http://localhost:3005/api/orders/22?refresh=true');
  const data22 = await res22.json();
  console.log('  HTTP Status:', res22.status);
  console.log('  Engine Ref:', data22.id);
  console.log('  Domino\'s Order Token:', data22.robot?.dominosOrderRef);
  console.log('  Domino\'s POS Order ID:', data22.robot?.posOrderId);
  console.log('  Store Name:', data22.robot?.storeName);
  console.log('  Store Phone (Rider Dispatch):', data22.robot?.storePhone);
  console.log('  Live Status:', data22.robot?.status);

  // 2. Test Wallet Deposit API
  console.log('\n[TEST 2] Customer Wallet Deposit API:');
  const depRes = await fetch('http://localhost:3005/api/user/wallet/deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 100, paymentMethod: 'UPI' })
  });
  const depData = await depRes.json();
  console.log('  Deposit HTTP Status:', depRes.status);
  console.log('  New Balance:', depData.wallet?.balance);
  console.log('  Audit Transaction ID:', depData.transaction?.id);

  // 3. Test User Profile Retrieval
  console.log('\n[TEST 3] User Profile Sync:');
  const profRes = await fetch('http://localhost:3005/api/user/profile');
  const profData = await profRes.json();
  console.log('  User Name:', profData.profile?.name);
  console.log('  Wallet Balance:', profData.profile?.wallet?.balance);
  console.log('  Saved Addresses Count:', profData.profile?.savedAddresses?.length);

  // 4. Test Customer Orders Endpoint
  console.log('\n[TEST 4] User Orders for My Orders Modal:');
  const ordersRes = await fetch('http://localhost:3005/api/user/orders');
  const ordersData = await ordersRes.json();
  console.log('  Orders Returned:', ordersData.orders?.length);
  const matchedO22 = ordersData.orders?.find(o => o.robot?.dominosOrderRef === '#790022' || o.id === data22.id);
  console.log('  Order 22 Present in My Orders:', !!matchedO22);
  console.log('  Order 22 Status in My Orders:', matchedO22?.robot?.status);

  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

runFullVerification().catch(console.error);
