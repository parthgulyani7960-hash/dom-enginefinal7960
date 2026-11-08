const dominosWorker = require('./dominosWorker');

class OrderQueue {
  constructor() {
    this.queue = [];
    this.activeWorkers = 0;
    this.maxConcurrent = 5; // Can process up to 5 concurrent Domino's robot orders
    this.paused = false;
  }

  enqueue(orderId) {
    console.log(`[QUEUE] Enqueued order ${orderId}`);
    this.queue.push(orderId);
    if (!this.paused) {
      this.processNext();
    } else {
      console.log(`[QUEUE] ⏸️ Order ${orderId} queued in standby (Robot Automation is PAUSED)`);
    }
  }

  pause() {
    this.paused = true;
    console.log(`[QUEUE] ⏸️ Robot dispatch queue PAUSED. Pending orders: ${this.queue.length}`);
    return this.paused;
  }

  resume() {
    this.paused = false;
    console.log(`[QUEUE] ▶️ Robot dispatch queue RESUMED. Processing ${this.queue.length} pending orders...`);
    this.processNext();
    return this.paused;
  }

  isPaused() {
    return !!this.paused;
  }

  async processNext() {
    if (this.paused) {
      return;
    }
    if (this.activeWorkers >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const orderId = this.queue.shift();
    this.activeWorkers++;

    try {
      await dominosWorker.processOrder(orderId);
    } catch (err) {
      console.error(`[QUEUE] Error processing order ${orderId}:`, err);
    } finally {
      this.activeWorkers--;
      this.processNext();
    }
  }
}

module.exports = new OrderQueue();
