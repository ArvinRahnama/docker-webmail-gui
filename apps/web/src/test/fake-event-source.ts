/**
 * jsdom implements no `EventSource`, so any component that opens a job
 * stream throws on mount — an unhandled error that fails the *file*, not
 * just the test that rendered it. This is the smallest stand-in that keeps
 * `useJobStream` honest: it opens nothing, delivers nothing on its own, and
 * records every instance so a test that wants to exercise the stream can
 * push frames through `emit()` and assert on `closed`.
 *
 * Deliberately not a network fake. Tests that care about stream *content*
 * drive it explicitly; tests that merely render a page get an inert socket
 * that never fires, which is the same thing a real browser would show
 * before the first frame arrives.
 */

type Listener = (event: MessageEvent<string>) => void;

// Deliberately not `implements EventSource`: the DOM interface's overloaded
// listener signatures and `this: EventSource` callbacks would force this
// double to satisfy generics no test needs. The single cast at the
// installation site in `setup.ts` is the honest, narrow place for the
// mismatch to live.
export class FakeEventSource {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;

  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;

  /** Every instance constructed since the last `reset()`, in order. */
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The most recently constructed instance, or `undefined` if none. */
  static get last(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1);
  }

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = FakeEventSource.CONNECTING;

  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  /** Drive the connection open, as the browser would on the first byte. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Deliver one default-type message frame. `data` is sent verbatim. */
  emit(data: string): void {
    this.readyState = FakeEventSource.OPEN;
    const event = new MessageEvent<string>('message', { data });
    this.onmessage?.(event);
    for (const listener of this.listeners.get('message') ?? []) {
      listener(event);
    }
  }

  /** Signal a transport error. Does not close: the real one reconnects. */
  fail(): void {
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** True once the component under test has cleaned the subscription up. */
  get closed(): boolean {
    return this.readyState === FakeEventSource.CLOSED;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(): boolean {
    return false;
  }
}
