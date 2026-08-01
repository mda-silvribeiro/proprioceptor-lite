// Synthetic sensor input. Headless Chromium (on a secure origin — 127.0.0.1
// counts) exposes real `DeviceOrientationEvent` / `DeviceMotionEvent`
// constructors whose init dictionaries carry alpha/beta/gamma/absolute and
// accelerationIncludingGravity, so the events the page receives here are the
// genuine article rather than look-alikes. `webkitCompassHeading` exists on no
// browser but Safari, so it is grafted on with defineProperty.
//
// The driver runs *inside* the page at ~60 Hz, which is the whole point: the app
// must coalesce that stream down to ~5 Hz frames on its own.

import type { Page } from "@playwright/test";

export type SensorMode =
  /** Android-style relative yaw: `absolute` false. */
  | "relative"
  /** Android with a magnetometer: `deviceorientationabsolute` + absolute flag. */
  | "absolute"
  /** iOS: relative alpha plus `webkitCompassHeading`. */
  | "ios"
  /** A platform that fires events but reports no angles at all. */
  | "nulls";

export interface DriverConfig {
  mode: SensorMode;
  /** Event period in ms. 16 ≈ 60 Hz, like a real phone. */
  intervalMs?: number;
  /** "still" holds |a| ≈ g; "moving" shakes it; "none" sends no devicemotion. */
  accel?: "still" | "moving" | "none";
  /** Fixed alpha, if a test needs a predictable heading. */
  alpha?: number;
  beta?: number;
  gamma?: number;
  /** iOS mode only: the compass bearing Safari would report. */
  compass?: number;
}

export interface StopPermissionStub {
  (): Promise<void>;
}

/**
 * Stubs the iOS-only permission gate before any page script runs. Chromium has
 * no `requestPermission`, so this is the only way to exercise that branch.
 */
export async function stubPermissionGate(
  page: Page,
  result: "granted" | "denied" | "throw",
): Promise<void> {
  await page.addInitScript((outcome: "granted" | "denied" | "throw") => {
    const stub = (): Promise<string> => {
      if (outcome === "throw") return Promise.reject(new Error("not allowed"));
      return Promise.resolve(outcome);
    };
    const target = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    target.requestPermission = stub;
    const motion = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    motion.requestPermission = stub;
    (window as unknown as { __permissionCalls: number }).__permissionCalls = 0;
    const counted = (): Promise<string> => {
      (window as unknown as { __permissionCalls: number }).__permissionCalls += 1;
      return stub();
    };
    target.requestPermission = counted;
    motion.requestPermission = counted;
  }, result);
}

/** How many times the page asked for motion permission. */
export async function permissionCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __permissionCalls?: number }).__permissionCalls ?? 0,
  );
}

/** Dispatch exactly one orientation event (plus its absolute twin when asked). */
export async function dispatchOrientation(
  page: Page,
  sample: {
    alpha: number | null;
    beta: number | null;
    gamma: number | null;
    absolute?: boolean;
    compassHeading?: number;
  },
): Promise<void> {
  await page.evaluate((input) => {
    const build = (type: string): DeviceOrientationEvent => {
      const event = new DeviceOrientationEvent(type, {
        alpha: input.alpha,
        beta: input.beta,
        gamma: input.gamma,
        absolute: input.absolute === true,
      });
      if (input.compassHeading !== undefined) {
        Object.defineProperty(event, "webkitCompassHeading", {
          value: input.compassHeading,
          configurable: true,
        });
        Object.defineProperty(event, "webkitCompassAccuracy", { value: 10, configurable: true });
      }
      return event;
    };
    window.dispatchEvent(build("deviceorientation"));
    if (input.absolute === true) window.dispatchEvent(build("deviceorientationabsolute"));
  }, sample);
}

/** Dispatch one devicemotion event; `null` means "the platform gave nothing". */
export async function dispatchMotion(
  page: Page,
  accel: { x: number; y: number; z: number } | null,
): Promise<void> {
  await page.evaluate((vector) => {
    const event =
      vector === null
        ? new DeviceMotionEvent("devicemotion", {})
        : new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: vector });
    window.dispatchEvent(event);
  }, accel);
}

/** Start a ~60 Hz event stream in the page. Idempotent per page. */
export async function startSensorDriver(page: Page, config: DriverConfig): Promise<void> {
  await page.evaluate((options) => {
    const scope = window as unknown as { __sensorDriver?: number };
    if (scope.__sensorDriver !== undefined) window.clearInterval(scope.__sensorDriver);
    let tick = 0;
    const period = options.intervalMs ?? 16;
    const accelMode = options.accel ?? "moving";
    scope.__sensorDriver = window.setInterval(() => {
      tick += 1;
      const nulls = options.mode === "nulls";
      // A slow yaw sweep and a gentle wobble: nothing here sits at zero, so a
      // fabricated zero in a frame is impossible to mistake for real data.
      const alpha = nulls ? null : (options.alpha ?? (tick * 1.5) % 360);
      const beta = nulls ? null : (options.beta ?? 20 + 8 * Math.sin(tick / 9));
      const gamma = nulls ? null : (options.gamma ?? -15 + 6 * Math.cos(tick / 7));
      const absolute = options.mode === "absolute";

      const build = (type: string): DeviceOrientationEvent => {
        const event = new DeviceOrientationEvent(type, { alpha, beta, gamma, absolute });
        if (options.mode === "ios") {
          // Safari's own value: already a clockwise-from-north bearing.
          Object.defineProperty(event, "webkitCompassHeading", {
            value: options.compass ?? (360 - (alpha ?? 0)) % 360,
            configurable: true,
          });
          Object.defineProperty(event, "webkitCompassAccuracy", { value: 15, configurable: true });
        }
        return event;
      };
      window.dispatchEvent(build("deviceorientation"));
      if (absolute) window.dispatchEvent(build("deviceorientationabsolute"));

      if (accelMode !== "none") {
        const shake = accelMode === "moving" ? 2.5 * Math.sin(tick / 3) : 0.02 * Math.sin(tick / 3);
        window.dispatchEvent(
          new DeviceMotionEvent("devicemotion", {
            accelerationIncludingGravity: { x: shake, y: 0.3 + shake / 2, z: 9.81 - shake / 3 },
          }),
        );
      }
    }, period);
  }, config);
}

export async function stopSensorDriver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __sensorDriver?: number | undefined };
    if (scope.__sensorDriver !== undefined) {
      window.clearInterval(scope.__sensorDriver);
      scope.__sensorDriver = undefined;
    }
  });
}

/** Replace `navigator.clipboard.writeText` with a recorder, before page scripts. */
export async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __copied: string[] };
    scope.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          scope.__copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

export async function copiedText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
}

/** Make `navigator.clipboard` unavailable so the execCommand path is taken. */
export async function stubClipboardUnavailable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __execCopies: string[] };
    scope.__execCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const original = document.execCommand.bind(document);
    document.execCommand = (command: string, ...rest: unknown[]): boolean => {
      if (command === "copy") {
        const active = document.querySelector("textarea.copy-shim");
        scope.__execCopies.push(active instanceof HTMLTextAreaElement ? active.value : "");
        return true;
      }
      return original(command, ...(rest as [boolean?, string?]));
    };
  });
}

export async function execCopies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __execCopies?: string[] }).__execCopies ?? []);
}
