// Touchscreen/trackpad shield harness — pure decision logic + wiring checks.
import fs from 'node:fs';
import {
  EDGE_THRESHOLD,
  GESTURE_BLUR_GRACE_MS,
  guardEntriesToSeed,
  isEdgeTouchStart,
  isRapidPop,
  shouldBlockTouchMove,
  shouldBlockWheel,
  wasRecentlyIntercepted,
} from '../src/lib/examGestureGuard.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const W = 1000;

console.log('\n## Layer 1 — edge detection');
check('left bezel', isEdgeTouchStart(10, W));
check('exact threshold', isEdgeTouchStart(EDGE_THRESHOLD, W));
check('just inside', !isEdgeTouchStart(EDGE_THRESHOLD + 1, W));
check('centre', !isEdgeTouchStart(500, W));
check('right bezel', isEdgeTouchStart(W - 10, W));
check('right threshold', isEdgeTouchStart(W - EDGE_THRESHOLD, W));

console.log('\n## Layer 1 — touch move decisions');
const move = (o) => shouldBlockTouchMove({ startX: 500, startY: 500, currentX: 500, currentY: 500, startedAtEdge: false, insideHorizontalWidget: false, ...o });
check('vertical scroll allowed', !move({ currentY: 300 }));
check('horizontal swipe blocked', move({ currentX: 540, currentY: 505 }));
check('diagonal (45°) allowed', !move({ currentX: 530, currentY: 530 }));
check('tiny jitter allowed', !move({ currentX: 505, currentY: 500 }));
check('horizontal swipe inside slider allowed', !move({ currentX: 540, insideHorizontalWidget: true }));
check('edge touch, tiny move allowed', !move({ currentX: 503, startedAtEdge: true }));
check('edge touch, real swipe blocked', move({ currentX: 512, startedAtEdge: true }));
check('edge swipe beats widget exemption', move({ currentX: 512, startedAtEdge: true, insideHorizontalWidget: true }));

console.log('\n## Layer 2 — trackpad wheel decisions');
const wheel = (o) => shouldBlockWheel({ deltaX: 0, deltaY: 0, insideScroller: false, atLeftEdge: false, atRightEdge: false, ...o });
check('vertical wheel untouched', !wheel({ deltaY: 120 }));
check('horizontal wheel blocked', wheel({ deltaX: 60, deltaY: 3 }));
check('tiny horizontal delta ignored', !wheel({ deltaX: 3, deltaY: 1 }));
check('table scroll with room allowed', !wheel({ deltaX: 60, deltaY: 2, insideScroller: true }));
check('table at left edge pushing left blocked', wheel({ deltaX: -60, deltaY: 2, insideScroller: true, atLeftEdge: true }));
check('table at right edge pushing right blocked', wheel({ deltaX: 60, deltaY: 2, insideScroller: true, atRightEdge: true }));
check('table at left edge pushing right allowed', !wheel({ deltaX: 60, deltaY: 2, insideScroller: true, atLeftEdge: true }));

console.log('\n## Layer 3 — history cushion');
check('first pop is not rapid', !isRapidPop(1000, 0));
check('pop within 300 ms is rapid', isRapidPop(1250, 1000));
check('pop after 300 ms is normal', !isRapidPop(1400, 1000));
check('rapid pop seeds a deeper cushion', guardEntriesToSeed(true) === 2);
check('normal pop seeds one entry', guardEntriesToSeed(false) === 1);

console.log('\n## Layer 4 — false-positive suppression');
check('no gesture → not suppressed', !wasRecentlyIntercepted(5000, 0));
check('blur 100 ms after gesture suppressed', wasRecentlyIntercepted(5100, 5000));
check('blur after grace period is a violation', !wasRecentlyIntercepted(5000 + GESTURE_BLUR_GRACE_MS + 1, 5000));
check('longer window honoured', wasRecentlyIntercepted(5599, 5000, 600));

console.log('\n## Wiring — runner actually uses the shield');
const runner = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');
check('imports the guard module', runner.includes("from '../lib/examGestureGuard'"));
check('uses shouldBlockTouchMove', runner.includes('shouldBlockTouchMove('));
check('uses shouldBlockWheel', runner.includes('shouldBlockWheel('));
check('uses the history cushion helpers', runner.includes('guardEntriesToSeed(') && runner.includes('isRapidPop('));
check('suppresses false violations', runner.includes('wasRecentlyIntercepted('));
check('non-passive touchmove listener', /addEventListener\('touchmove', handleTouchMove, \{ passive: false \}\)/.test(runner));
check('non-passive wheel listener', /addEventListener\('wheel', handleWheel, \{ passive: false \}\)/.test(runner));
check('seeds 3 guard entries', runner.includes('seedGuardEntries(3)'));

const css = fs.readFileSync('src/pages/StudentQuizRunner.css', 'utf8');
check('CSS contains containment for question cards', /\.sq-question-card[\s\S]{0,200}overscroll-behavior-x: none/.test(css));
check('CSS contains table-local containment', /\.sq-scrollable-table[\s\S]{0,200}overscroll-behavior-x: contain/.test(css));

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
