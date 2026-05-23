type ResolverPair<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function defineMethod(target: object, name: string, value: unknown): void {
  if (name in target) return
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  })
}

defineMethod(
  Array.prototype,
  'toSorted',
  function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
    return [...this].sort(compareFn)
  },
)

defineMethod(
  Map.prototype,
  'getOrInsertComputed',
  function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, callback: (key: K) => V): V {
    if (this.has(key)) return this.get(key) as V
    const value = callback(key)
    this.set(key, value)
    return value
  },
)

defineMethod(
  Map.prototype,
  'getOrInsert',
  function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
    if (this.has(key)) return this.get(key) as V
    this.set(key, value)
    return value
  },
)

defineMethod(
  WeakMap.prototype,
  'getOrInsertComputed',
  function getOrInsertComputed<K extends WeakKey, V>(this: WeakMap<K, V>, key: K, callback: (key: K) => V): V {
    if (this.has(key)) return this.get(key) as V
    const value = callback(key)
    this.set(key, value)
    return value
  },
)

defineMethod(
  WeakMap.prototype,
  'getOrInsert',
  function getOrInsert<K extends WeakKey, V>(this: WeakMap<K, V>, key: K, value: V): V {
    if (this.has(key)) return this.get(key) as V
    this.set(key, value)
    return value
  },
)

const PromiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers?: <T>() => ResolverPair<T>
}

if (!PromiseWithResolvers.withResolvers) {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(): ResolverPair<T> {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
      })
      return { promise, resolve, reject }
    },
  })
}

if (globalThis.crypto && !globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      const bytes = new Uint8Array(16)
      globalThis.crypto.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
    },
  })
}

const ReadableStreamPrototype = globalThis.ReadableStream?.prototype as
  | (ReadableStream<unknown> & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })
  | undefined

if (ReadableStreamPrototype && !ReadableStreamPrototype[Symbol.asyncIterator]) {
  Object.defineProperty(ReadableStreamPrototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* asyncIterator<T>(this: ReadableStream<T>): AsyncGenerator<T> {
      const reader = this.getReader()
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) return
          yield result.value
        }
      } finally {
        reader.releaseLock()
      }
    },
  })
}
