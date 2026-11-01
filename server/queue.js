const dominosWorker = require('./dominosWorker');

class OrderQueue {
  constructor() {
    this.queue = [];
    this.activeWorkers = 0;
    this.maxConcurrent = 5; // Can process up to 5 concurrent Domino's robot orders
  }

  enqueue(orderId) {
    console.log(`[QUEUE] Enqueued order ${orderId}`);
    this.queue.push(orderId);
    this.processNext();
  }

  async processNext() {
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
