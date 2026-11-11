const db = require('./db');
const { runSessionTrainingCycle } = require('./trainAndBenchmarkMiddleman');

async function main() {
  console.log('===============================================================');
  console.log('🚀 DOMINO\'S FLEET MULTI-SESSION TRAINING & STRESS BENCHMARK');
  console.log('===============================================================');

  const fleetAccounts = db.data.accounts.filter(a => ['ACC-DOM-0325', 'ACC-DOM-2158', 'ACC-DOM-3155'].includes(a.id));
  console.log(`Found ${fleetAccounts.length} active fleet accounts for parallel execution.`);

  const testItems = [
    { name: 'Margherita', customSize: 'Regular', customCrust: 'New Hand Tossed' },
    { name: 'Golden Corn', customSize: 'Regular', customCrust: 'Classic Hand Tossed' },
    { name: 'Farmhouse', customSize: 'Medium', customCrust: 'Cheese Burst' },
    { name: 'Garlic Breadsticks' }
  ];

  console.log('Test items per session:', testItems.map(i => `${i.name}${i.customSize ? ' [' + i.customSize + ', ' + i.customCrust + ']' : ''}`));
  console.log('Starting parallel sessions across fleet...\n');

  const startTime = Date.now();

  const sessionPromises = fleetAccounts.map(account => {
    return runSessionTrainingCycle({
      accountSession: account,
      storeId: '66409', // SECTOR-15C, CHANDIGARH
      testItems: testItems,
      cycles: 3, // 3 comprehensive training cycles
      onLog: (msg) => console.log(msg)
    });
  });

  const results = await Promise.all(sessionPromises);

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n===============================================================');
  console.log(`🏁 BENCHMARK COMPLETE ACROSS ALL FLEET SESSIONS IN ${totalElapsed}s`);
  console.log('===============================================================');

  results.forEach(r => {
    console.log(`\n📊 Account: ${r.phone}`);
    console.log(`   Cycles completed: ${r.cyclesCompleted}`);
    console.log(`   Total time: ${(r.totalTimeMs / 1000).toFixed(1)}s`);
    console.log('   Item addition timings:');
    r.itemAddResults.forEach(item => {
      console.log(`     - ${item.item}: ${item.durationMs}ms`);
    });
    console.log('   Pruning & removal timings:');
    r.pruneResults.forEach(p => {
      console.log(`     - Pass ${p.cycle}: Removed ${p.itemsRemoved} items in ${p.durationMs}ms`);
    });
    if (r.error) {
      console.log(`   ⚠️ Notice: ${r.error}`);
    }
  });

  // Ensure accounts stay IDLE in DB
  fleetAccounts.forEach(a => {
    a.status = 'IDLE';
    a.activeOrderId = null;
  });
  db.save();
  console.log('\n✓ Fleet sessions reset to IDLE and ready for production orders.');
}

main().catch(err => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});
