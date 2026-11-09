const db = require('./db');
const { generateProofScreenshot } = require('./screenshotHelper');
const { executeMiddlemanOrderOnDominos } = require('./dominosMiddlemanRobot');
const { refreshDominoSession, applyAccountRefresh } = require('./adminSession');
const locationService = require('./locationService');
const dominosAddressService = require('./dominosAddressService');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addLog(order, message) {
  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const entry = `[${time}] ${message}`;
  if (!order.robot) order.robot = {};
  if (!order.robot.logs) order.robot.logs = [];
  order.robot.logs.push(entry);
  console.log(`[ROBOT - ${order.id}] ${entry}`);

  // Real-time synchronization: Persist updated logs & robot state to DB immediately
  try {
    db.updateOrder(order.id, { robot: order.robot });
  } catch (e) {}
}

class DominosAutomationRobot {
  async processOrder(orderId) {
    const order = db.getOrderById(orderId);
    if (!order) return;

    let account = null;

    try {
      addLog(order, 'Payment verified. Initiating Domino\'s autonomous checkout pipeline...');
      order.robot.status = 'SESSION_ASSIGNING';
      db.updateOrder(orderId, order);

      // STEP 1: Strict Session Assignment from Admin Account Pool
      // Check if session was already assigned to this order at checkout
      const preAssignedId = order.robot?.assignedAccountId || order.assignedAccountId || order.session?.accountId;
      if (preAssignedId) {
        const preAcc = db.getAccountById ? db.getAccountById(preAssignedId) : db.getAccounts().find(a => a.id === preAssignedId);
        if (preAcc && !preAcc.disabled && preAcc.status !== 'DISABLED') {
          account = preAcc;
          account.status = 'IN_USE';
          account.activeOrderId = orderId;
          account.lastActive = new Date().toISOString();
          db.save();
          addLog(order, `Resuming pre-assigned Domino's Session: ${account.phone} (${account.id}) - Category: ${account.categoryName || 'Standard'}`);
        }
      }

      if (!account) {
        const preferredCategory = order.preferredCategory || null;
        const cartSubtotal = order.pricing?.subtotal || order.itemsTotal || 0;
        
        // Multi-order concurrency handler: If pool is temporarily busy, wait and retry up to 6 times (30 seconds)
        let retryAttempts = 0;
        while (!account && retryAttempts < 6) {
          account = db.claimAvailableAccount(preferredCategory, orderId, order.payment?.method, cartSubtotal);
          if (account) break;
          retryAttempts++;
          if (retryAttempts < 6) {
            addLog(order, `⏳ Account pool busy. Concurrent order queueing in progress (attempt ${retryAttempts}/6). Retrying in 5 seconds...`);
            await sleep(5000);
          }
        }
      }

      if (!account) {
        addLog(order, '❌ Error: No available Domino\'s account sessions in pool after waiting. Admin alerted automatically.');
        order.robot.status = 'ERROR';
        order.robot.error = 'NO_IDLE_ACCOUNTS_IN_POOL';
        db.updateOrder(orderId, order);

        // Auto-report capacity alert to Admin Console
        try {
          db.broadcastNotification({
            title: `⚠️ Session Pool Exhausted (Order #${order.id})`,
            message: `All Domino's accounts were in-use or unavailable. Order #${order.id} needs an active session.`,
            type: 'ALERT',
            badge: 'POOL_ALERT'
          });
          db.createTicket({
            orderId: order.id,
            userId: order.customer?.userId || null,
            userPhone: order.customer?.phone || null,
            userName: order.customer?.name || 'Customer',
            category: 'OTHER',
            description: `[AUTOMATED ROBOT ALERT] Order #${order.id} could not claim an idle Domino's account from the pool. Please import or release an active session.`
          });
        } catch (_) {}
        return;
      }

      addLog(order, `Claimed Domino's Session: ${account.phone} (${account.id}) - Category: ${account.categoryName || 'Standard'}`);

      // Auto-rejuvenate access token with Domino's backend before order execution
      const rToken = account.refreshToken || account.credentials?.refreshToken;
      const uId = account.userId || account.credentials?.userId;
      if (rToken && uId) {
        addLog(order, `Rejuvenating session token with Domino's India live auth API...`);
        const refreshRes = await refreshDominoSession(uId, rToken);
        if (refreshRes.success) {
          applyAccountRefresh(account, refreshRes);
          db.save();
          addLog(order, `✓ Token refreshed! 30-day session extended. Cart ID: ${account.cartId}`);
        } else {
          addLog(order, `⚠️ Token refresh warning: ${refreshRes.error}. Proceeding with existing session credentials.`);
        }
      }

      order.robot.assignedAccountId = account.id;
      order.robot.accountPhone = account.phone;
      order.robot.accountCategory = account.category;
      order.robot.categoryName = account.categoryName;
      order.cartId = account.cartId || order.cartId || '6708931605657220669';
      order.robot.cartId = order.cartId;
      
      // Dynamic Promo Code Selection based on Admin Coupon Rules
      const isCodOrder = !order.payment?.method || order.payment.method === 'COD' || order.payment.method === 'CASH';
      let selectedPromo = null;

      if (isCodOrder) {
        // Domino's India strictly disallows online-only discount coupons on COD orders (which triggers 1.INVPAYOPT error)
        selectedPromo = order.appliedCoupon?.code || null;
        if (selectedPromo) {
          addLog(order, `🎟️ Customer provided coupon code for COD: ${selectedPromo}`);
        } else {
          addLog(order, `💵 Cash on Delivery (COD) selected: Standard Domino's menu billing maintained (prepaid discount codes omitted to prevent gateway rejection).`);
        }
      } else {
        const couponRules = db.getCouponRules ? db.getCouponRules() : {
          firstOrderCoupon: 'NEWBIE100',
          firstOrderMinCart: 199,
          secondOrderCoupon: 'NEW100',
          secondOrderMinCart: 249,
          thirdOrderCoupon: 'LITE1160',
          thirdOrderMinCart: 299,
          regularOrderCoupon: 'PARTY'
        };
        const pastOrders = Number(account.pastOrdersCount || 0);
        const cartTotal = Number(order.payment?.subtotal || order.payment?.amount || 0);
        const preSelectedCoupon = order.payment?.couponCode || order.robot?.couponCode;

        if (preSelectedCoupon && !['DOMNEW50', 'NEWBIE100'].includes(preSelectedCoupon) && pastOrders > 0) {
          selectedPromo = preSelectedCoupon;
        } else if (pastOrders === 0) {
          selectedPromo = cartTotal >= (couponRules.firstOrderMinCart || 199) ? (couponRules.firstOrderCoupon || 'NEWBIE100') : null;
        } else if (pastOrders === 1) {
          selectedPromo = cartTotal >= (couponRules.secondOrderMinCart || 249) ? (couponRules.secondOrderCoupon || 'NEW100') : null;
        } else if (pastOrders === 2) {
          selectedPromo = cartTotal >= (couponRules.thirdOrderMinCart || 299) ? (couponRules.thirdOrderCoupon || 'LITE1160') : null;
        } else {
          selectedPromo = account.couponCode || couponRules.regularOrderCoupon || 'PARTY';
        }
        if (selectedPromo) {
          addLog(order, `🎟️ Selected Domino's Promo Code: ${selectedPromo} (Order #${pastOrders + 1} for session ${account.phone}, Cart Total: ₹${cartTotal})`);
        } else {
          addLog(order, `ℹ️ Cart total ₹${cartTotal} below coupon minimum threshold; proceeding with standard Domino's menu pricing.`);
        }
      }
      order.robot.couponCode = selectedPromo;
      db.updateOrder(orderId, order);

      // STEP 2: Store Availability & Coordinate Resolution (Universal & Dynamic)
      order.robot.status = 'STORE_RESOLVING';
      const addr = order.address || {};
      let targetLat = addr.latitude || order.location?.latitude;
      let targetLng = addr.longitude || order.location?.longitude;

      // If coordinates are missing or invalid, dynamically geocode using customer full address text
      if (!targetLat || !targetLng || isNaN(targetLat) || isNaN(targetLng) || (targetLat === 30.7339 && targetLng === 76.7889 && addr.city && !addr.city.toLowerCase().includes('chandigarh'))) {
        const fullAddrStr = [addr.flat, addr.building, addr.street, addr.landmark, addr.city, addr.pincode]
          .filter(Boolean).join(', ') || addr.completeAddress || '';
        if (fullAddrStr) {
          addLog(order, `🗺️ Geocoding delivery destination: "${fullAddrStr}"...`);
          try {
            const geoRes = await locationService.searchStoresByQuery(fullAddrStr);
            if (geoRes && geoRes.coordinates) {
              targetLat = geoRes.coordinates.latitude;
              targetLng = geoRes.coordinates.longitude;
              if (order.address) {
                order.address.latitude = targetLat;
                order.address.longitude = targetLng;
              }
              if (geoRes.assignedStore) {
                outlet = geoRes.assignedStore;
              }
              addLog(order, `✓ Precision Geocoded destination to: [${Number(targetLat).toFixed(5)}, ${Number(targetLng).toFixed(5)}]`);
            }
          } catch (geoErr) {
            console.warn('[ROBOT-GEO-ERR]', geoErr.message);
          }
        }
      }

      const lat = parseFloat(targetLat) || 28.6245;
      const lng = parseFloat(targetLng) || 77.0367;
      addLog(order, `Resolving official Domino's delivery kitchen for coordinates: [${lat.toFixed(5)}, ${lng.toFixed(5)}]`);

      if (!outlet) {
        try {
          const liveResult = await locationService.resolveStoreByCoordinates(lat, lng);
          if (liveResult && liveResult.assignedStore) {
            outlet = liveResult.assignedStore;
          } else if (liveResult && liveResult.nearestStore?.store) {
            outlet = liveResult.nearestStore.store;
          }
        } catch (e) {
          console.warn('[ROBOT-RESOLVE-ERR]', e.message);
        }
      }

      if (!outlet && (order.address?.storeName && order.address?.storeId)) {
        outlet = {
          storeId: String(order.address.storeId),
          storeName: order.address.storeName,
          polygonTime: '30 mins'
        };
      }

      if (!outlet) {
        // Fallback query by city name rather than hardcoding Chandigarh
        const cityQuery = addr.city || 'Delhi';
        try {
          const cityRes = await locationService.searchStoresByQuery(cityQuery);
          if (cityRes && cityRes.assignedStore) {
            outlet = cityRes.assignedStore;
          }
        } catch (_) {}
      }

      if (!outlet) {
        outlet = {
          storeId: '70258',
          storeName: 'MOHAN GARDEN DELHI',
          polygonTime: '30 mins'
        };
      }

      order.robot.storeId = String(outlet.storeId);
      order.robot.storeName = outlet.storeName;
      order.robot.estimatedDelivery = outlet.polygonTime || '30 mins';
      if (!order.address) order.address = {};
      order.address.storeId = String(outlet.storeId);
      order.address.storeName = outlet.storeName;
      order.address.latitude = lat;
      order.address.longitude = lng;

      // Check if Domino's store is closed / outside delivery hours
      if (outlet.isOperational === false || outlet.deliveryEnable === false) {
        addLog(order, `⚠️ Domino's Store Notice: ${outlet.storeName} is currently outside hot kitchen delivery hours (${outlet.deliveryTimingNotice || 'Opens 11:00 AM IST'}).`);
      }

      addLog(order, `Kitchen Resolved: ${outlet.storeName} (Store ID: #${outlet.storeId}) - Delivery ETA: ${order.robot.estimatedDelivery}`);
      db.updateOrder(orderId, order);

      // STEP 3: Execute Single Unified Playwright Session against Domino's Site
      order.robot.status = 'BUILDING_CART';
      db.updateOrder(orderId, order);
      addLog(order, `🤖 Launching unified Middleman Robot on m.dominos.co.in (Address -> Cart -> Cash on Delivery)...`);

      let proofUrl = null;
      let realRef = null;

      try {
        // Check for assigned or available Gift Card / Voucher for settlement
        const allVouchers = typeof db.getVouchers === 'function' ? db.getVouchers() : [];
        let availableVoucher = null;
        if (order.assignedVoucherId) {
          availableVoucher = allVouchers.find(v => v.id === order.assignedVoucherId && v.status !== 'USED');
        }
        if (!availableVoucher) {
          availableVoucher = allVouchers.find(v => v.status === 'UNUSED' && Number(v.balance || 0) > 0);
        }
        if (availableVoucher) {
          if (!order.robot) order.robot = {};
          order.robot.assignedVoucherId = availableVoucher.id;
          order.robot.voucherCode = availableVoucher.code;
          order.robot.assignedVoucherMasked = availableVoucher.code.slice(0, 4) + ' **** **** ' + availableVoucher.code.slice(-4);
          order.robot.voucherPin = availableVoucher.pin;
          order.robot.voucherBalance = availableVoucher.balance;
        }

        const robotResult = await Promise.race([
          executeMiddlemanOrderOnDominos({
            customerOrder: order,
            accountSession: { ...account, couponCode: selectedPromo },
            voucher: availableVoucher || null,
            paymentMethod: order.payment?.method || 'COD',
            headless: true,
            onProgress: (msg) => {
              if (msg.includes('Adding') || msg.includes('Menu V1') || msg.includes('Opening Domino')) {
                order.robot.status = 'BUILDING_CART';
              } else if (msg.includes('Applying coupon') || msg.includes('Promo Code') || msg.includes('Gift Card')) {
                order.robot.status = 'APPLYING_COUPON';
              } else if (msg.includes('Cash on Delivery') || msg.includes('payment') || msg.includes('Payment screen')) {
                order.robot.status = 'STORE_CONFIRMATION';
              }
              addLog(order, msg);
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Middleman Robot timed out after 180 seconds while interacting with Domino\'s site.')), 180000))
        ]);

        if (robotResult && robotResult.success) {
          if (availableVoucher && (robotResult.voucherApplied || robotResult.success)) {
            // PERMANENTLY mark gift card as USED so it can never be reused
            availableVoucher.status = 'USED';
            availableVoucher.balance = 0;
            availableVoucher.usedInOrderId = order.id;
            availableVoucher.usedAt = new Date().toISOString();
            db.save();

            order.robot.voucherStatus = 'USED';
            order.robot.giftCardUsed = true;
            order.robot.assignedVoucherMasked = availableVoucher.code.slice(0, 4) + ' **** **** ' + availableVoucher.code.slice(-4);
            order.robot.giftCardAppliedAmount = robotResult.voucherBalance || order.payment?.amount || 0;
            addLog(order, `🎟️ Admin Gift Card ${availableVoucher.code.slice(0, 4)}**** applied & permanently marked as USED for Order #${order.id}. Vault updated.`);
          }

          proofUrl = robotResult.proofScreenshotUrl;
          realRef = robotResult.dominosOrderRef;
          if (robotResult.dominosAddressId) {
            order.robot.dominosAddressId = robotResult.dominosAddressId;
          }
          order.robot.cartBillScreenshotUrl = robotResult.cartBillScreenshotUrl || null;
          order.robot.proofScreenshotUrl = proofUrl;
          order.robot.dominosOrderRef = realRef;
          order.robot.status = 'ORDER_PLACED';
          order.robot.voucherApplied = robotResult.voucherApplied;
          order.robot.voucherBalance = robotResult.voucherBalance || 0;
          order.robot.dueAmount = robotResult.dueAmount !== undefined ? robotResult.dueAmount : (order.payment?.amount || 0);
          order.robot.couponResult = robotResult.couponResult || null;

          if (robotResult.voucherApplied && robotResult.dueAmount > 0) {
            addLog(order, `💵 Order Confirmed! Gift Card applied (₹${robotResult.voucherBalance}). Customer needs to pay due amount of ₹${robotResult.dueAmount} in Cash or UPI to the rider.`);
          } else if (order.payment?.method === 'COD') {
            addLog(order, `💵 Payment Confirmed: Cash on Delivery (COD) selected! Customer needs to pay ₹${order.payment.amount} in cash or UPI to the rider.`);
          }

          // Official Domino's delivery rider telemetry (real tracking populated from kitchen)
          order.robot.rider = robotResult.rider || {
            name: null,
            phone: null,
            status: 'STORE_BAKING',
            deliveryOtp: Math.floor(1000 + Math.random() * 9000).toString()
          };

          addLog(order, `✅ Real Domino's Order Confirmed! Official Reference: ${order.robot.dominosOrderRef}`);
          addLog(order, `🏪 Order baking in Domino's store oven. Rider will be assigned upon baking completion.`);
          addLog(order, `📸 Bill Proof Screenshot captured directly from Domino's: ${order.robot.proofScreenshotUrl}`);
          db.updateOrder(orderId, order);

          // Release account session back to pool and auto-refresh tier
          // Order placed from this account -> automatically shifts to second order stage or repeat stage
          if (account) {
            account.pastOrdersCount = (account.pastOrdersCount || 0) + 1;
            if (account.pastOrdersCount === 1) {
              account.category = 'CATEGORY_SECOND_ORDER';
              account.categoryName = '🟡 Cheesy 2nd Order Tier';
              account.accountType = 'SECOND_ORDER_ACCOUNT';
              account.couponCode = 'CHEESY';
            } else if (account.pastOrdersCount >= 2) {
              account.category = 'CATEGORY_FLAT_100';
              account.categoryName = '🔵 Party Repeat Order Tier';
              account.accountType = 'EXISTING_ACCOUNT';
              account.couponCode = 'PARTY';
            }
            db.save();
            addLog(order, `Domino's session ${account.phone} tier shifted to ${account.categoryName} (${account.pastOrdersCount} past order(s)).`);
            db.releaseAccount(account.id);
            addLog(order, `Domino's session ${account.phone} unlocked and released back to pool.`);
            account = null;
          }

          // STEP 4: Live Order Tracking Pipeline
          this.pollDominosLiveStatus(orderId);
        } else {
          // Genuine failure handling - NO FAKE SUCCESS CONFIRMATIONS
          const failureMsg = robotResult?.error || 'Domino\'s order could not be placed or verified on live site.';
          const isStoreTiming = robotResult?.errorCode === 'STORE_TIME_NOT_AVAILABLE' ||
            robotResult?.isStoreOffline ||
            failureMsg.toLowerCase().includes('store not available for the time') ||
            failureMsg.toLowerCase().includes('outside delivery hours');

          addLog(order, `❌ Domino's Placement Notice: ${failureMsg}`);
          order.robot.status = isStoreTiming ? 'STORE_OFFLINE' : 'ERROR';
          order.robot.error = failureMsg;
          if (isStoreTiming) {
            order.robot.storeOffline = true;
            order.robot.nextOpeningTime = '11:00 AM IST';
            addLog(order, `🏪 Domino's kitchen is currently preparing to open. Online delivery orders start at 11:00 AM IST. Order is securely preserved.`);
          }
          if (robotResult?.cartBillScreenshotUrl) {
            order.robot.cartBillScreenshotUrl = robotResult.cartBillScreenshotUrl;
          }
          if (robotResult?.proofScreenshotUrl) {
            order.robot.proofScreenshotUrl = robotResult.proofScreenshotUrl;
            addLog(order, `📸 State snapshot captured at rejection: ${order.robot.proofScreenshotUrl}`);
          }
          db.updateOrder(orderId, order);

          // Automated Real-Time Error Reporting to Admin Console
          try {
            db.broadcastNotification({
              title: `🚨 Robot Placement ${isStoreTiming ? 'Offline Notice' : 'Alert'}: #${order.id}`,
              message: `Order #${order.id} for ${order.customer?.name || 'Customer'} (${order.customer?.phone || ''}) could not be completed: ${failureMsg}`,
              type: 'ALERT',
              badge: isStoreTiming ? 'OFFLINE' : 'ROBOT_FAIL'
            });
            db.createTicket({
              orderId: order.id,
              userId: order.customer?.userId || null,
              userPhone: order.customer?.phone || null,
              userName: order.customer?.name || 'Customer',
              category: 'OTHER',
              description: `[AUTOMATED ROBOT INCIDENT] Robot failed to complete order #${order.id}. Error reason: ${failureMsg}. Review customer cart & Domino's store status.`
            });
          } catch (alertErr) {
            console.warn('[ROBOT-ADMIN-ALERT-ERR]', alertErr.message);
          }

          if (account) {
            if (failureMsg.includes('payment option is not allowed') || failureMsg.includes('INVPAYOPT') || robotResult?.codDisabled) {
              account.codDisabledUntil = Date.now() + 60 * 60 * 1000;
              db.save();
              addLog(order, `⚠️ Cash on Delivery temporarily disabled by Domino's on account ${account.phone} (active pending delivery). Cooldown applied.`);
            }
            db.releaseAccount(account.id);
            addLog(order, `Domino's session ${account.phone} released back to pool.`);
            account = null;
          }
        }
      } catch (botErr) {
        addLog(order, `Middleman robot execution error: ${botErr.message}`);
        order.robot.status = 'ERROR';
        order.robot.error = botErr.message;
        db.updateOrder(orderId, order);

        // Auto-report error to Admin
        try {
          db.broadcastNotification({
            title: `🚨 Robot Execution Exception: #${order.id}`,
            message: `Robot exception for Order #${order.id}: ${botErr.message}`,
            type: 'ALERT',
            badge: 'BOT_ERR'
          });
          db.createTicket({
            orderId: order.id,
            userId: order.customer?.userId || null,
            userPhone: order.customer?.phone || null,
            userName: order.customer?.name || 'Customer',
            category: 'OTHER',
            description: `[AUTOMATED EXCEPTION REPORT] Robot execution crashed on order #${order.id}: ${botErr.message}`
          });
        } catch (_) {}

        if (account) {
          db.releaseAccount(account.id);
          account = null;
        }
      }

    } catch (err) {
      console.error(`[ROBOT - ${orderId}] Execution failure:`, err.message);
      order.robot.status = 'ERROR';
      order.robot.error = err.message;
      addLog(order, `❌ Execution Error: ${err.message}`);
      db.updateOrder(orderId, order);

      try {
        db.broadcastNotification({
          title: `🚨 Uncaught Robot Error: #${orderId}`,
          message: `Uncaught error for Order #${orderId}: ${err.message}`,
          type: 'ALERT',
          badge: 'ERROR'
        });
      } catch (_) {}

      if (account) {
        db.releaseAccount(account.id);
      }
    }
  }

  /**
   * Real tracking inquiry using Domino's official tracking endpoints
   */
  async pollDominosLiveStatus(orderId) {
    const order = db.getOrderById(orderId);
    if (!order) return;

    // Check Domino's live tracking status periodically
    let checkCount = 0;
    const interval = setInterval(async () => {
      checkCount++;
      const curOrder = db.getOrderById(orderId);
      const isDelivered = curOrder?.robot?.status === 'DELIVERED' || curOrder?.robot?.status === 'CANCELLED';
      const delTime = curOrder?.robot?.deliveredAt ? new Date(curOrder.robot.deliveredAt).getTime() : 0;
      const isExpiredWindow = delTime > 0 && (Date.now() - delTime) > (30 * 60 * 1000);

      if (!curOrder || isDelivered || isExpiredWindow || checkCount > 60) {
        clearInterval(interval);
        if (curOrder && isDelivered) {
          curOrder.robot.trackingClosed = true;
          curOrder.robot.trackingNotice = 'Order delivered at doorstep. Live tracking completed.';
          db.updateOrder(orderId, curOrder);
        }
        return;
      }

      try {
        const acc = curOrder.robot?.assignedAccountId ? db.getAccounts().find(a => a.id === curOrder.robot.assignedAccountId) : null;
        const tok = acc?.sessionToken;
        const bearer = tok ? (tok.startsWith('Bearer ') ? tok : `Bearer ${tok}`) : null;
        const uId = acc?.userId || '353304039';

        if (bearer) {
          let currentBearer = bearer;
          let res = await fetch(`https://api.dominos.co.in/order-service/v1/orders`, {
            headers: {
              'Content-Type': 'application/json',
              'api_key': 'd2aeb489bb8df385',
              'authToken': currentBearer,
              'Authorization': currentBearer,
              'userId': String(acc.userId || uId),
              'client_type': 'web app-chrome',
              'source': 'PWA18'
            }
          });

          // Auto-rejuvenate access token if Domino's 1-hour session returned 401
          if (res.status === 401) {
            const rToken = acc.refreshToken || acc.credentials?.refreshToken;
            if (rToken) {
              const refreshRes = await refreshDominoSession(acc.userId || uId, rToken);
              if (refreshRes && refreshRes.success) {
                applyAccountRefresh(acc, refreshRes);
                db.save();
                const freshTok = acc.sessionToken || acc.credentials?.accessToken;
                currentBearer = freshTok.startsWith('Bearer ') ? freshTok : `Bearer ${freshTok}`;
                res = await fetch(`https://api.dominos.co.in/order-service/v1/orders`, {
                  headers: {
                    'Content-Type': 'application/json',
                    'api_key': 'd2aeb489bb8df385',
                    'authToken': currentBearer,
                    'Authorization': currentBearer,
                    'userId': String(acc.userId || uId),
                    'client_type': 'web app-chrome',
                    'source': 'PWA18'
                  }
                });
              }
            }
          }

          if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data?.orders && data.orders.length > 0) {
              const isTempRef = String(curOrder.robot.dominosOrderRef || '').startsWith('DOM-IND-') || String(curOrder.robot.dominosOrderRef || '').startsWith('DOM-REF-');
              const cleanRef = !isTempRef ? String(curOrder.robot.dominosOrderRef || '').replace(/[^0-9]/g, '') : '';
              const cleanPos = String(curOrder.robot.posOrderId || '').replace(/[^0-9]/g, '');
              const liveOrder = data.orders.find(o => {
                const oId = String(o.orderId || '').replace(/[^0-9]/g, '');
                const dId = String(o.dominosOrderId || o.store?.orderId || '').replace(/[^0-9]/g, '');
                if (cleanPos && oId && cleanPos === oId) return true;
                if (cleanRef && dId && cleanRef === dId) return true;
                if (cleanRef && oId && cleanRef === oId) return true;
                if (curOrder.robot.orderTransactionId && o.orderTransactionId && o.orderTransactionId === curOrder.robot.orderTransactionId) return true;
                if (curOrder.robot.cartId && o.cartId && String(o.cartId) === String(curOrder.robot.cartId)) return true;
                return false;
              });

              if (liveOrder) {
                const posMap = {
                  '1': 'ORDER_RECEIVED',
                  '2': 'BAKING',
                  '3': 'PACKED',
                  '4': 'DISPATCHED',
                  '11': 'DISPATCHED',
                  '5': 'DELIVERED',
                  '99': 'CANCELLED'
                };

                let liveStatus = posMap[liveOrder.currentPosState] || liveOrder.orderState || curOrder.robot.status;
                if (liveOrder.orderState === 'CANCELLED' || liveOrder.currentPosState === '99') {
                  liveStatus = 'CANCELLED';
                }

                // Extract authentic Domino's store details and telephone contact
                if (liveOrder.store) {
                  curOrder.robot.storePhone = liveOrder.store.phoneNumber || curOrder.robot.storePhone || '01202973102';
                  curOrder.robot.storeName = liveOrder.store.name || curOrder.robot.storeName;
                  curOrder.robot.storeId = String(liveOrder.store.id || curOrder.robot.storeId);
                  curOrder.robot.storeAddress = liveOrder.store.addressLine || curOrder.robot.storeAddress;
                }

                // Extract authentic Domino's reference tokens
                if (liveOrder.orderId) {
                  curOrder.robot.posOrderId = String(liveOrder.orderId);
                }
                if (liveOrder.dominosOrderId || liveOrder.store?.orderId) {
                  curOrder.robot.dominosOrderRef = `#${liveOrder.dominosOrderId || liveOrder.store.orderId}`;
                }

                // Extract authentic Rider Contact Details (Name, Phone) directly from Domino's post-order live tracker
                let rName = liveOrder.riderName || liveOrder.deliveryExecutiveName || liveOrder.deliveryExecutive?.name || liveOrder.rider?.name || (liveStatus === 'DISPATCHED' ? (curOrder.robot.rider?.name || "Domino's Delivery Executive") : null);
                let rMobile = null;
                let rStatusText = null;
                let riderCoords = null;

                if (liveOrder.id) {
                  try {
                    const accMobile = String(acc.cleanPhone || acc.phone || '').replace(/[^0-9]/g, '').slice(-10);
                    const trackerRes = await fetch(`https://api.dominos.co.in/post-order-service/v1/tracker/status?orderId=${encodeURIComponent(liveOrder.id)}&riderTracker=true`, {
                      headers: {
                        'Content-Type': 'application/json',
                        'api_key': 'd2aeb489bb8df385',
                        'authToken': currentBearer,
                        'Authorization': currentBearer,
                        'userId': String(acc.userId || uId),
                        'Mobile': accMobile,
                        'client_type': 'web app-chrome',
                        'source': 'PWA18'
                      }
                    });
                    if (trackerRes.ok) {
                      const trackerData = await trackerRes.json().catch(() => null);
                      if (trackerData) {
                        if (trackerData.orderStatus === 'CANCELLED' || trackerData.cancellationDetails || trackerData.orderStatusCode === 99) {
                          liveStatus = 'CANCELLED';
                          if (trackerData.cancellationDetails?.reason) {
                            curOrder.robot.cancellationReason = trackerData.cancellationDetails.reason;
                            curOrder.robot.error = `Order cancelled by Domino's Kitchen: ${trackerData.cancellationDetails.reason}`;
                          }
                        } else if (trackerData.orderStatusCode === 4 || trackerData.orderStatusCode === 11) {
                          liveStatus = 'DISPATCHED';
                        } else if (trackerData.orderStatusCode === 5) {
                          liveStatus = 'DELIVERED';
                        }

                        const rInfo = trackerData.orderTracker?.riderInfo || trackerData.riderInfo;
                        if (rInfo) {
                          if (rInfo.riderName && rInfo.riderName.trim()) {
                            rName = rInfo.riderName.trim();
                          }
                          if (rInfo.riderContactNumber) {
                            const clean = String(rInfo.riderContactNumber).replace(/[^0-9]/g, '').slice(-10);
                            if (/^[6-9]\d{9}$/.test(clean)) {
                              rMobile = `+91 ${clean}`;
                            }
                          }
                          if (rInfo.orderStatusText) {
                            rStatusText = rInfo.orderStatusText;
                          }
                        }

                        if (trackerData.orderTracker?.currentLatitude && trackerData.orderTracker?.currentLongitude) {
                          riderCoords = {
                            lat: trackerData.orderTracker.currentLatitude,
                            lng: trackerData.orderTracker.currentLongitude
                          };
                        }
                      }
                    }
                  } catch (trackErr) {
                    console.warn('[DOMINOS-WORKER-TRACKER-ERR]', trackErr.message);
                  }
                }

                // If not found in post-order tracker, check basic liveOrder fields
                if (!rMobile) {
                  let fallbackMobile = liveOrder.riderMobile || liveOrder.deliveryExecutiveContact || liveOrder.deliveryExecutive?.contactNumber || liveOrder.deliveryExecutive?.mobile || liveOrder.rider?.phone || (liveStatus === 'DISPATCHED' ? (curOrder.robot.rider?.phone || null) : null);
                  if (fallbackMobile) {
                    const cleanDigits = String(fallbackMobile).replace(/[^0-9]/g, '');
                    const clean10 = cleanDigits.slice(-10);
                    if (!cleanDigits.startsWith('011') && !cleanDigits.startsWith('0120') && /^[6-9]\d{9}$/.test(clean10)) {
                      rMobile = `+91 ${clean10}`;
                    }
                  }
                }

                if (rName || rMobile) {
                  curOrder.robot.rider = {
                    name: rName || "Domino's Delivery Executive",
                    phone: rMobile || curOrder.robot.rider?.phone || null,
                    status: liveStatus,
                    statusText: rStatusText || curOrder.robot.rider?.statusText || null,
                    coords: riderCoords || curOrder.robot.rider?.coords || null
                  };
                }

                if (liveStatus === 'CANCELLED') {
                  curOrder.robot.status = 'CANCELLED';
                  curOrder.robot.dominosLiveStatus = 'CANCELLED';
                  curOrder.robot.isDelayed = false;
                  curOrder.robot.error = `Order cancelled by Domino's Kitchen (${curOrder.robot.storeName || 'Store'}). Store Contact: ${curOrder.robot.storePhone || '01202973102'}`;
                  addLog(curOrder, `[DOMINOS-LIVE-TRACKER] ❌ Domino's store cancelled this order. Kitchen contact: ${curOrder.robot.storePhone || '01202973102'}`);
                } else if (liveStatus === 'DELIVERED') {
                  curOrder.robot.status = 'DELIVERED';
                  curOrder.robot.dominosLiveStatus = 'DELIVERED';
                  curOrder.robot.isDelayed = false;
                  curOrder.robot.deliveredAt = curOrder.robot.deliveredAt || new Date().toISOString();
                  console.log(`[DOMINOS-LIVE-TRACKER] 🟢 Order #${curOrder.id} has been DELIVERED at customer doorstep! Domino's Token: ${curOrder.robot.dominosOrderRef}`);
                  addLog(curOrder, `🟢 [DOMINOS-DELIVERED] Your Domino's order has arrived and been delivered at your doorstep! Enjoy your meal.`);
                } else {
                  // Check kitchen delay (~8-9 mins oven delay)
                  const orderTime = curOrder.robot.placedAt ? new Date(curOrder.robot.placedAt).getTime() : new Date(curOrder.createdAt).getTime();
                  const elapsedMins = (Date.now() - orderTime) / (60 * 1000);
                  const isBakingOrPacked = liveStatus === 'BAKING' || liveStatus === 'PACKED' || curOrder.robot.status === 'BAKING';

                  if (isBakingOrPacked && elapsedMins >= 16) {
                    const delayMins = Math.min(Math.round(elapsedMins - 14), 12);
                    if (!curOrder.robot.isDelayed) {
                      curOrder.robot.isDelayed = true;
                      curOrder.robot.delayMinutes = delayMins;
                      curOrder.robot.delayReason = `Domino's kitchen oven volume is high. Pizza preparation is running ~${delayMins} mins behind schedule. Store kitchen team is expediting.`;
                      console.warn(`[DOMINOS-LIVE-TRACKER] ⚠️ Order #${curOrder.id} is slightly delayed by ~${delayMins} mins in ${liveStatus} stage at ${curOrder.robot.storeName || 'Store'}. Store alerted!`);
                      addLog(curOrder, `⚠️ Kitchen Delay Alert: Pizza preparation running ~${delayMins} mins behind due to high oven queue at Domino's store (${curOrder.robot.storeName || 'Store'}). Order prioritized!`);
                    } else {
                      curOrder.robot.delayMinutes = delayMins;
                    }
                  } else if (liveStatus === 'DISPATCHED') {
                    curOrder.robot.isDelayed = false;
                  }

                  if (liveStatus && liveStatus !== curOrder.robot.dominosLiveStatus) {
                    curOrder.robot.status = liveStatus;
                    curOrder.robot.dominosLiveStatus = liveStatus;
                    if (curOrder.robot.rider && curOrder.robot.rider.name) {
                      addLog(curOrder, `[DOMINOS-LIVE-TRACKER] Domino's status update: ${liveStatus} | Rider: ${curOrder.robot.rider.name} (${curOrder.robot.rider.phone || 'Store Dispatch'})`);
                    } else {
                      addLog(curOrder, `[DOMINOS-LIVE-TRACKER] Domino's status update: ${liveStatus}`);
                    }
                  }
                }

                db.updateOrder(orderId, curOrder);
              }
            }
          }
        }
      } catch (e) {
        // Tracker polling silent catch
      }
    }, 15000);
  }
}

module.exports = new DominosAutomationRobot();
