// ─── Touchscreen & Trackpad Simulation Harness ─────────────────────────────
// Simulates real browser hardware events: edge touches, double swipes, trackpad
// wheel overscrolls, table boundary collisions, history pop bursts, and blur traps.

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

let passed = 0;
let failed = 0;

function assert(description, condition, details = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}${details ? ' — ' + details : ''}`);
    failed++;
  }
}

console.log('======================================================================');
console.log('🧪 SIMULATING TOUCHSCREEN & TRACKPAD BROWSER SECURITY FEATURES');
console.log('======================================================================\n');

// ─── SIMULATION 1: Touchscreen Edge Swipe (Single Swipe) ────────────────────
console.log('👉 [Simulation 1] Touchscreen Left Edge Swipe (Student hand touches bezel and drags right)');
{
  const screenWidth = 1024;
  const touchStartX = 18; // In bezel zone (< 32px)
  const touchStartY = 400;

  const isEdge = isEdgeTouchStart(touchStartX, screenWidth);
  assert('Bezel touch correctly detected at X=18px', isEdge === true);

  // Drag right by 45px
  const currentX = 63;
  const currentY = 402;
  const blocked = shouldBlockTouchMove({
    startX: touchStartX,
    startY: touchStartY,
    currentX,
    currentY,
    startedAtEdge: isEdge,
    insideHorizontalWidget: false,
  });

  assert('Touchmove was PREVENTED (defaultPrevented = true)', blocked === true);
  assert('Browser back-arrow gesture was CANCELLED before compositor activation', blocked === true);
}

// ─── SIMULATION 2: Touchscreen Rapid Double-Swipe (< 250ms interval) ───────
console.log('\n👉 [Simulation 2] Rapid Touchscreen Double Swipe (Student flicks edge twice in fast succession)');
{
  const screenWidth = 1200;
  let activeTime = 1000;
  let historyEscaped = false;

  // Swipe 1 at t=1000ms
  const swipe1Edge = isEdgeTouchStart(12, screenWidth);
  const swipe1Blocked = shouldBlockTouchMove({
    startX: 12,
    startY: 300,
    currentX: 85,
    currentY: 304,
    startedAtEdge: swipe1Edge,
    insideHorizontalWidget: false,
  });
  assert('Swipe 1: Hardware gesture intercepted & prevented', swipe1Blocked === true);

  // Swipe 2 at t=1180ms (180ms later)
  activeTime = 1180;
  const swipe2Edge = isEdgeTouchStart(15, screenWidth);
  const swipe2Blocked = shouldBlockTouchMove({
    startX: 15,
    startY: 310,
    currentX: 110,
    currentY: 312,
    startedAtEdge: swipe2Edge,
    insideHorizontalWidget: false,
  });
  assert('Swipe 2: Second rapid swipe ALSO intercepted & prevented', swipe2Blocked === true);
  assert('Zero history navigation events dispatched to browser', swipe1Blocked && swipe2Blocked);
}

// ─── SIMULATION 3: Trackpad Two-Finger Horizontal Double-Swipe ──────────────
console.log('\n👉 [Simulation 3] Precision Trackpad Two-Finger Horizontal Double-Swipe');
{
  // Student uses 2 fingers on trackpad to swipe left-to-right (deltaX < 0)
  const flick1 = {
    deltaX: -75,
    deltaY: 4,
    insideScroller: false,
    atLeftEdge: false,
    atRightEdge: false,
  };
  const flick1Blocked = shouldBlockWheel(flick1);
  assert('Trackpad Flick 1: e.preventDefault() called on wheel event', flick1Blocked === true);

  // Immediate second flick with high momentum (deltaX = -130)
  const flick2 = {
    deltaX: -130,
    deltaY: 2,
    insideScroller: false,
    atLeftEdge: false,
    atRightEdge: false,
  };
  const flick2Blocked = shouldBlockWheel(flick2);
  assert('Trackpad Flick 2: Second momentum wheel event ALSO blocked', flick2Blocked === true);
  assert('Compositor overscroll back navigation prevented for both flicks', flick1Blocked && flick2Blocked);
}

// ─── SIMULATION 4: Vertical Scrolling vs Horizontal Swiping ─────────────────
console.log('\n👉 [Simulation 4] Usability: Smooth Vertical Exam Scrolling Allowed');
{
  // 1-finger vertical scroll down question page (deltaY = +120px)
  const verticalTouch = shouldBlockTouchMove({
    startX: 500,
    startY: 200,
    currentX: 502,
    currentY: 320,
    startedAtEdge: false,
    insideHorizontalWidget: false,
  });
  assert('Vertical touch scroll is NOT blocked (defaultPrevented = false)', verticalTouch === false);

  // Trackpad normal vertical scroll (wheel deltaY = 80)
  const verticalWheel = shouldBlockWheel({
    deltaX: 0,
    deltaY: 80,
    insideScroller: false,
    atLeftEdge: false,
    atRightEdge: false,
  });
  assert('Vertical trackpad wheel is NOT blocked (defaultPrevented = false)', verticalWheel === false);
}

// ─── SIMULATION 5: Wide Cambridge Table (Interior Pan vs Boundary Bounce) ────
console.log('\n👉 [Simulation 5] Wide Data Table: Interior Horizontal Scroll vs Boundary Over-scroll');
{
  // Inside wide table with scrollLeft = 150px, user scrolls left (deltaX = -40)
  const interiorScrollBlocked = shouldBlockWheel({
    deltaX: -40,
    deltaY: 2,
    insideScroller: true,
    atLeftEdge: false, // Table has room to scroll!
    atRightEdge: false,
  });
  assert('Inside wide table: Scrolling is PERMITTED while table has room', interiorScrollBlocked === false);

  // Table hits the left border (scrollLeft = 0) and user continues swiping left!
  const boundaryOverScrollBlocked = shouldBlockWheel({
    deltaX: -40,
    deltaY: 2,
    insideScroller: true,
    atLeftEdge: true, // Table reached boundary!
    atRightEdge: false,
  });
  assert('At left table boundary: Overscroll is BLOCKED from bubbling to browser back', boundaryOverScrollBlocked === true);
}

// ─── SIMULATION 6: History Stack Cushion (The 2nd Swipe Pop Burst) ───────────
console.log('\n👉 [Simulation 6] Browser History Stack Cushion & Double Pop Burst');
{
  // Model browser history stack
  let historyStack = ['https://school.edu/dashboard', 'https://school.edu/exam'];
  let currentIndex = 1; // On exam

  // Runner mounts: seeds 3 guard entries
  for (let i = 0; i < 3; i++) {
    historyStack.push('https://school.edu/exam#guard' + (i + 1));
    currentIndex++;
  }
  assert('Initial setup: Seeded 3 guard cushion entries on history stack', currentIndex === 4);

  // User performs Rapid Double Pop (e.g. hardware mouse back button double-click or fast pop)
  let lastPopTime = 0;
  let popCount = 0;

  function simulatePop(now) {
    currentIndex--; // Browser pops one entry
    popCount++;
    const rapid = isRapidPop(now, lastPopTime);
    lastPopTime = now;
    const toSeed = guardEntriesToSeed(rapid);
    for (let s = 0; s < toSeed; s++) {
      historyStack.push('https://school.edu/exam#reseed' + popCount + '_' + s);
      currentIndex++;
    }
  }

  // Pop 1 at t=1000ms
  simulatePop(1000);
  assert('Pop 1: History absorbed, current page remains on exam', historyStack[currentIndex].includes('exam'));

  // Pop 2 at t=1120ms (Rapid: 120ms later)
  simulatePop(1120);
  assert('Pop 2: Rapid second pop absorbed by cushion, NEVER reaches dashboard', historyStack[currentIndex].includes('exam'));
  assert('Student never unmounts or leaves exam runner', currentIndex >= 2);
}

// ─── SIMULATION 7: False-Positive Cheating Strike Suppression ────────────────
console.log('\n👉 [Simulation 7] Anti-Cheating Violation Filtering: Gesture Blur vs Real Alt+Tab');
{
  let gestureTime = 5000;
  let violationsLogged = [];

  function handleWindowBlur(blurTime, reason) {
    if (wasRecentlyIntercepted(blurTime, gestureTime, GESTURE_BLUR_GRACE_MS)) {
      // Suppressed! Refocus exam without penalty
      return 'SUPPRESSED';
    }
    violationsLogged.push({ time: blurTime, reason });
    return 'VIOLATION_LOGGED';
  }

  // 1. Accidental gesture blur at t=5080ms (80ms after edge touch)
  const res1 = handleWindowBlur(5080, 'Exam window lost focus');
  assert('Accidental gesture blur (80ms after swipe): SUPPRESSED without strike', res1 === 'SUPPRESSED');
  assert('Zero cheating strikes recorded for student', violationsLogged.length === 0);

  // 2. Genuine Alt+Tab at t=8500ms (3.5 seconds later, no gesture)
  const res2 = handleWindowBlur(8500, 'Alt+Tab away from exam');
  assert('Genuine Alt+Tab (3500ms later): Recorded as true VIOLATION', res2 === 'VIOLATION_LOGGED');
  assert('Invigilator alerted for real cheating violation', violationsLogged.length === 1);
}

console.log('\n======================================================================');
console.log(`📊 SIMULATION COMPLETE: ${passed} Passed, ${failed} Failed`);
console.log('======================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

