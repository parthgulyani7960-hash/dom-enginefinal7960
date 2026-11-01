const db = require('./db');
const { refreshDominoSession, applyAccountRefresh } = require('./adminSession');

async function inspectLiveDominosOrders() {
  const accounts = db.getAccounts();
  for (const acc of accounts) {
    console.log('========================================');
    console.log('Account Phone:', acc.phone, 'ID:', acc.id);
    let tok = acc.sessionToken || acc.credentials?.accessToken;
    if (!tok) {
      console.log('No token');
      continue;
    }
    let bearer = tok.startsWith('Bearer ') ? tok : 'Bearer ' + tok;
    let uId = String(acc.userId || acc.credentials?.userId || '366623451');

    try {
      let res = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
        headers: {
          'Content-Type': 'application/json',
          'api_key': 'd2aeb489bb8df385',
          'authToken': bearer,
          'Authorization': bearer,
          'userId': uId,
          'client_type': 'web app-chrome',
          'source': 'PWA18'
        }
      });
      console.log('HTTP Status:', res.status);

      if (res.status === 401) {
        console.log('Token expired, attempting refresh...');
        const rToken = acc.refreshToken || acc.credentials?.refreshToken;
        if (rToken) {
          const refreshRes = await refreshDominoSession(uId, rToken);
          if (refreshRes && refreshRes.success) {
            applyAccountRefresh(acc, refreshRes);
            db.save();
            tok = acc.sessionToken || acc.credentials?.accessToken;
            bearer = tok.startsWith('Bearer ') ? tok : 'Bearer ' + tok;
            res = await fetch('https://api.dominos.co.in/order-service/v1/orders', {
              headers: {
                'Content-Type': 'application/json',
                'api_key': 'd2aeb489bb8df385',
                'authToken': bearer,
                'Authorization': bearer,
                'userId': String(acc.userId),
                'client_type': 'web app-chrome',
                'source': 'PWA18'
              }
            });
            console.log('After refresh HTTP Status:', res.status);
          }
        }
      }

      if (res.ok) {
        const data = await res.json();
        console.log('Total orders in Domino API for this account:', data.orders ? data.orders.length : 0);
        if (data.orders) {
          data.orders.forEach((o, idx) => {
            console.log('\n--- Order #' + (idx + 1) + ' ---');
            console.log('orderId (POS):', o.orderId);
            console.log('dominosOrderId (Store token):', o.dominosOrderId);
            console.log('currentPosState:', o.currentPosState);
            console.log('orderState:', o.orderState);
            console.log('store:', o.store);
            console.log('paymentDetails:', o.paymentDetails);
            console.log('deliveryAddress:', o.deliveryAddress);
            console.log('Full Order Keys:', Object.keys(o));
            // Print any key that might have rider or tracking info
            for (const [k, v] of Object.entries(o)) {
              if (['rider', 'driver', 'delivery', 'deliveryExecutive', 'executive', 'track', 'agent', 'phone', 'contact'].some(sub => k.toLowerCase().includes(sub))) {
                console.log('Matched key [' + k + ']:', JSON.stringify(v));
              }
            }
          });
        }
      } else {
        const text = await res.text();
        console.log('Response body:', text);
      }
    } catch (e) {
      console.error('Fetch err:', e.message);
    }
  }
}

inspectLiveDominosOrders().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
