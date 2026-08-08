// motion.js - the physics and the screen changes.
//
// What it does: a small critically-damped spring integrator for drag release,
// the rubber-band curve used when a gesture pulls past its limit, one
// View-Transitions wrapper with a Web-Animations fallback, and a height
// collapse for a row that is finished. The decision "View Transitions or not"
// is made once here, at module load, so no screen has to branch on it.
//
// What it deliberately does NOT do: no DOM structure of its own, no CSS class
// names beyond the ones it is handed, no timers that outlive their element,
// no easing library. Everything honours prefers-reduced-motion: with the
// setting on, every animation resolves immediately and the end state is
// applied without an intermediate frame.

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** @returns {boolean} true when the user asked for less movement. */
export function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia(REDUCE_QUERY).matches;
}

/** Decided once at load: the browser either has View Transitions or it does not. */
export const SUPPORTS_VIEW_TRANSITIONS =
  typeof document !== "undefined" && typeof document.startViewTransition === "function";

/**
 * Resistance curve for dragging past a boundary. The first pixels move almost
 * one to one, further ones give way progressively - the same feel as a list
 * pulled past its end.
 * @param {number} offset how far the finger went past the limit
 * @param {number} limit the distance at which resistance is fully felt
 * @returns {number} the distance the element should actually move
 */
export function rubberBand(offset, limit = 120) {
  const sign = offset < 0 ? -1 : 1;
  const x = Math.abs(offset);
  return (sign * (1 - 1 / (x / limit + 1)) * limit) / 0.55;
}

/**
 * Spring integrator. Semi-implicit Euler at frame rate, stopped when both the
 * displacement and the velocity are below the rest thresholds.
 * @returns {() => void} cancel
 */
export function spring({
  from = 0,
  to = 0,
  velocity = 0,
  stiffness = 220,
  damping = 26,
  mass = 1,
  restDistance = 0.35,
  restVelocity = 1.2,
  onUpdate,
  onDone,
} = {}) {
  if (prefersReducedMotion()) {
    if (onUpdate) onUpdate(to, 0);
    if (onDone) onDone();
    return () => {};
  }
  let value = from;
  let v = velocity;
  let raf = 0;
  let last = 0;
  let cancelled = false;

  const step = (now) => {
    if (cancelled) return;
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    const force = -stiffness * (value - to) - damping * v;
    v += (force / mass) * dt;
    value += v * dt;
    if (Math.abs(value - to) < restDistance && Math.abs(v) < restVelocity) {
      if (onUpdate) onUpdate(to, 0);
      if (onDone) onDone();
      return;
    }
    if (onUpdate) onUpdate(value, v);
    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}

/**
 * Run a DOM update as one visual change. With View Transitions the browser
 * cross-fades and morphs the elements carrying a view-transition-name; without
 * them the container gets a short Web-Animations fade so the change still
 * reads as one movement instead of a jump.
 * @param {Element} container element to animate in the fallback path
 * @param {() => void|Promise<void>} update the DOM mutation
 * @param {{direction?: "in"|"out"|"none"}} [opts]
 * @returns {Promise<void>} resolves when the change is visible
 */
export async function transition(container, update, opts = {}) {
  const reduce = prefersReducedMotion();
  if (reduce || !container) {
    await update();
    return;
  }
  if (SUPPORTS_VIEW_TRANSITIONS) {
    const vt = document.startViewTransition(() => update());
    try {
      await vt.finished;
    } catch {
      // A transition interrupted by the next one is normal, not an error.
    }
    return;
  }
  const dir = opts.direction === "out" ? -1 : 1;
  await update();
  const anim = container.animate(
    [
      { opacity: 0, transform: `translate3d(0, ${8 * dir}px, 0) scale(${1 - 0.012 * dir})` },
      { opacity: 1, transform: "none" },
    ],
    { duration: 260, easing: "cubic-bezier(.16,1,.3,1)" },
  );
  try {
    await anim.finished;
  } catch {
    // Element removed mid-flight; nothing to clean up.
  }
}

/**
 * Collapse an element to zero height and resolve when it is gone. Used when a
 * step is ticked off: the row folds away instead of blinking out.
 * @returns {Promise<void>}
 */
export async function collapse(el) {
  if (!el) return;
  if (prefersReducedMotion()) return;
  const h = el.getBoundingClientRect().height;
  const anim = el.animate(
    [
      { height: `${h}px`, opacity: 1, marginBottom: getComputedStyle(el).marginBottom },
      { height: "0px", opacity: 0, marginBottom: "0px" },
    ],
    { duration: 300, easing: "cubic-bezier(.16,1,.3,1)" },
  );
  el.style.overflow = "hidden";
  try {
    await anim.finished;
  } catch {
    // Removed early: the caller is about to re-render anyway.
  }
}

/** Mark an element as the morph target of the next transition. */
export function nameTransition(el, name) {
  if (!el || !SUPPORTS_VIEW_TRANSITIONS) return;
  el.style.viewTransitionName = name;
}

/** Remove a morph name again so it cannot collide with the next screen. */
export function clearTransition(el) {
  if (!el) return;
  el.style.viewTransitionName = "";
}

/**
 * Drop every morph name below `root`. A View Transition captures the OLD tree,
 * so two elements still carrying the same name - the hero of the screen being
 * left and the row being opened - would abort the transition. Called once
 * before a new name is handed out.
 */
export function clearAllTransitionNames(root) {
  if (!root || !SUPPORTS_VIEW_TRANSITIONS) return;
  for (const node of root.querySelectorAll("[style*='view-transition-name']")) {
    node.style.viewTransitionName = "";
  }
}
