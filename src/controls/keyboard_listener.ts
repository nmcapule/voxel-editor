export interface KeyCombination {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  type?: 'keydown' | 'keyup' | 'keypress';
}

function hashKeyCombination(input: KeyCombination) {
  return `${input.key}|${!!input.shift}|${!!input.ctrl}|${input.type || 'keypress'}`;
}

function parseKeyCombinationShortcut(input: string) {
  input = input.toLowerCase();

  let shift = false,
    ctrl = false,
    type = 'keypress';

  if (input.includes('shift+')) {
    shift = true;
    input = input.replace('shift+', '');
  }
  if (input.includes('ctrl+')) {
    ctrl = true;
    input = input.replace('ctrl+', '');
  }
  if (input.includes('v+')) {
    type = 'keydown';
    input = input.replace('v+', '');
  }
  if (input.includes('^+')) {
    type = 'keyup';
    input = input.replace('^+', '');
  }
  return { key: input, ctrl, shift, type } as KeyCombination;
}

export default class KeyboardListener {
  pressedKeys = new Set<string>();
  listeners = new Map<string, Set<Function>>();

  constructor(readonly element: HTMLElement) {
    this.element.addEventListener('keydown', this.onKeyDown.bind(this));
    this.element.addEventListener('keyup', this.onKeyUp.bind(this));
  }

  dispose() {
    this.element.removeEventListener('keydown', this.onKeyDown.bind(this));
    this.element.removeEventListener('keyup', this.onKeyUp.bind(this));
  }

  private onKeyDown(event: KeyboardEvent) {
    this.pressedKeys.add(event.key.toLowerCase());

    this.checkAndTrigger({
      key: event.key.toLowerCase(),
      shift: !!event.shiftKey,
      ctrl: !!event.ctrlKey,
      type: 'keydown',
    });
  }

  private onKeyUp(event: KeyboardEvent) {
    this.checkAndTrigger({
      key: event.key.toLowerCase(),
      shift: !!event.shiftKey,
      ctrl: !!event.ctrlKey,
      type: 'keyup',
    });

    this.pressedKeys.delete(event.key.toLowerCase());
  }

  update(elapsed: number) {
    const shift = this.pressedKeys.has('shift');
    const ctrl = this.pressedKeys.has('ctrl');

    for (let key of this.pressedKeys) {
      this.checkAndTrigger({ key, shift, ctrl, type: 'keypress' }, elapsed);
    }
  }

  keypress(input: string | KeyCombination): boolean {
    if (typeof input === 'string') {
      input = parseKeyCombinationShortcut(input);
    }

    if (!this.pressedKeys.has(input.key.toLowerCase())) {
      return false;
    }
    if (input?.shift !== this.pressedKeys.has('shift')) {
      return false;
    }
    if (input?.ctrl !== this.pressedKeys.has('ctrl')) {
      return false;
    }
    return true;
  }

  private checkAndTrigger(input: KeyCombination, elapsed = 0) {
    if (!this.keypress(input)) {
      return;
    }

    const callbacks = this.listeners.get(hashKeyCombination(input)) || new Set();
    for (let callback of callbacks) {
      callback(elapsed, input);
    }
  }

  on(input: string | KeyCombination, callback: Function, disposeCallback?: Function) {
    if (typeof input === 'string') {
      input = parseKeyCombinationShortcut(input);
    }
    const key = hashKeyCombination(input);
    const callbacks = this.listeners.get(key) || new Set();
    this.listeners.set(key, callbacks.add(callback));

    const dispose = () => {
      const callbacks = this.listeners.get(key);
      callbacks.delete(callback);
      if (callbacks.size > 0) {
        this.listeners.set(key, callbacks);
      } else {
        this.listeners.delete(key);
      }

      disposeCallback && disposeCallback();
    };

    // Allow chained `on` method calls.
    dispose.on = (input, callback) => this.on(input, callback, dispose);

    return dispose;
  }
}
