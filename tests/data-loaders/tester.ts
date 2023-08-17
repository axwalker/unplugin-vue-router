/**
 * @vitest-environment happy-dom
 */
import { type App, type Ref, defineComponent, inject, shallowRef } from 'vue'
// import { defineLoader } from '../defineLoader'
import { expectType } from 'ts-expect'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { getRouter } from 'vue-router-mock'
import { setCurrentContext } from '~/src/data-fetching_new/utils'
import {
  DataLoaderPlugin,
  type DataLoaderPluginOptions,
  NavigationResult,
} from '~/src/data-fetching_new/navigation-guard'
import type {
  DataLoaderContextBase,
  DefineDataLoader,
  UseDataLoader,
} from '~/src/data-fetching_new/createDataLoader'
import { mockPromise, mockedLoader } from '~/tests/utils'
import RouterViewMock from '~/tests/data-loaders/RouterViewMock.vue'
import ComponentWithNestedLoader from '~/tests/data-loaders/ComponentWithNestedLoader.vue'
import { dataOneSpy, dataTwoSpy } from '~/tests/data-loaders/loaders'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

export function testDefineLoader(
  name: string,
  defineLoader: DefineDataLoader<DataLoaderContextBase>
) {
  describe(name, () => {
    beforeEach(() => {
      // invalidate current context
      setCurrentContext(undefined)
      dataOneSpy.mockClear()
      dataTwoSpy.mockClear()
    })

    enableAutoUnmount(afterEach)

    // we use fake timers to ensure debugging tests do not rely on timers
    const now = new Date(2000, 0, 1).getTime() // 1 Jan 2000 in local time as number of milliseconds
    beforeAll(() => {
      vi.useFakeTimers()
      vi.setSystemTime(now)
    })

    afterAll(() => {
      vi.useRealTimers()
    })

    function singleLoaderOneRoute<Loader extends UseDataLoader>(
      useData: Loader,
      pluginOptions?: Omit<DataLoaderPluginOptions, 'router'>
    ) {
      let useDataResult: ReturnType<Loader>
      const component = defineComponent({
        setup() {
          // @ts-expect-error: wat?
          useDataResult = useData()

          const { data, error, pending } = useDataResult
          return { data, error, pending }
        },
        template: `\
<div>
  <p id="route">{{ $route.path }}</p>
  <p id="data">{{ data }}</p>
  <p id="error">{{ error }}</p>
  <p id="pending">{{ pending }}</p>
</div>`,
      })
      const router = getRouter()
      router.addRoute({
        name: '_test',
        path: '/fetch',
        meta: {
          loaders: [useData],
        },
        component,
      })

      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [[DataLoaderPlugin, { router, ...pluginOptions }]],
        },
      })

      const app: App = wrapper.vm.$.appContext.app

      return {
        wrapper,
        router,
        useData: () => {
          if (useDataResult) {
            return useDataResult
          }
          // forced to ensure similar running context to within a component
          // this is for tests that call useData() before the navigation is finished
          setCurrentContext(undefined)
          return app.runWithContext(() => useData()) as ReturnType<Loader>
        },
        app,
      }
    }

    describe.each(['immediate', 'after-load'] as const)(
      'commit: %s',
      (commit) => {
        describe.each([true, false] as const)('lazy: %s', (lazy) => {
          it(`can resolve an "null" with lazy: ${lazy}, commit: ${commit}`, async () => {
            const spy = vi
              .fn<unknown[], Promise<unknown>>()
              .mockResolvedValueOnce(null)
            const { wrapper, useData, router } = singleLoaderOneRoute(
              defineLoader(async () => spy(), { lazy, commit })
            )
            await router.push('/fetch')
            expect(spy).toHaveBeenCalledTimes(1)
            const { data } = useData()
            expect(data.value).toEqual(null)
          })

          it(`sets the value after navigation with lazy: ${lazy}, commit: ${commit}`, async () => {
            const spy = vi
              .fn<unknown[], Promise<string>>()
              .mockResolvedValueOnce('resolved')
            const { wrapper, useData, router } = singleLoaderOneRoute(
              // TODO: should allow sync loaders too?
              defineLoader(async () => spy(), { lazy, commit })
            )
            expect(spy).not.toHaveBeenCalled()
            await router.push('/fetch')
            expect(wrapper.get('#error').text()).toBe('')
            expect(wrapper.get('#pending').text()).toBe('false')
            expect(wrapper.get('#data').text()).toBe('resolved')
            expect(spy).toHaveBeenCalledTimes(1)
            const { data } = useData()
            expect(data.value).toEqual('resolved')
          })

          it(`can be forced refreshed with lazy: ${lazy}, commit: ${commit}`, async () => {
            const spy = vi
              .fn<unknown[], Promise<string>>()
              .mockResolvedValueOnce('resolved 1')
            const { wrapper, router, useData } = singleLoaderOneRoute(
              defineLoader(async () => spy())
            )
            await router.push('/fetch')
            expect(spy).toHaveBeenCalledTimes(1)
            const { data, refresh } = useData()
            expect(data.value).toEqual('resolved 1')
            spy.mockResolvedValueOnce('resolved 2')
            await refresh()
            expect(spy).toHaveBeenCalledTimes(2)
            expect(data.value).toEqual('resolved 2')
            spy.mockResolvedValueOnce('resolved 3')
            await refresh()
            expect(spy).toHaveBeenCalledTimes(3)
            expect(data.value).toEqual('resolved 3')
          })

          describe('app.runWithContext()', () => {
            it('can inject globals', async () => {
              const { wrapper, router, useData, app } = singleLoaderOneRoute(
                defineLoader(async () => {
                  return inject('key', 'ko')
                })
              )
              app.provide('key', 'ok')
              await router.push('/fetch')
              const { data } = useData()
              expect(data.value).toEqual('ok')
            })

            it('can inject globals in nested loaders', async () => {
              const nestedLoader = defineLoader(async () => {
                return inject('key', 'ko')
              })
              const { wrapper, router, useData, app } = singleLoaderOneRoute(
                defineLoader(async () => {
                  return await nestedLoader()
                })
              )
              app.provide('key', 'ok')
              await router.push('/fetch')
              const { data } = useData()
              expect(data.value).toEqual('ok')
            })

            it('can inject globals in nested loaders that run after other loaders', async () => {
              const l1 = defineLoader(async () => {
                return inject('key', 'ko')
              })
              const l2 = defineLoader(async () => {
                return inject('key', 'ko')
              })
              const { wrapper, router, useData, app } = singleLoaderOneRoute(
                defineLoader(async () => {
                  const a = await l1()
                  const b = await l2()
                  return `${a},${b}`
                })
              )
              app.provide('key', 'ok')
              await router.push('/fetch')
              const { data } = useData()
              expect(data.value).toEqual('ok,ok')
            })

            it('can inject globals when refreshed', async () => {
              const { wrapper, router, useData, app } = singleLoaderOneRoute(
                defineLoader(async () => {
                  return inject('key', 'ko')
                })
              )
              await router.push('/fetch')
              const { data, refresh } = useData()
              expect(data.value).not.toBe('ok')
              app.provide('key', 'ok')
              await refresh()
              expect(data.value).toBe('ok')
            })

            it('can inject globals in nested loaders when refreshed', async () => {
              const l1 = defineLoader(async () => {
                return inject('key', 'ko')
              })
              const l2 = defineLoader(async () => {
                return inject('key', 'ko')
              })
              const { wrapper, router, useData, app } = singleLoaderOneRoute(
                defineLoader(async () => {
                  const a = await l1()
                  const b = await l2()
                  return `${a},${b}`
                })
              )
              await router.push('/fetch')
              const { data, refresh } = useData()
              expect(data.value).not.toBe('ok,ok')
              app.provide('key', 'ok')
              await refresh()
              expect(data.value).toBe('ok,ok')
            })
          })
        })

        it(`should abort the navigation if a non lazy loader throws, commit: ${commit}`, async () => {
          const { wrapper, router } = singleLoaderOneRoute(
            defineLoader(
              async () => {
                throw new Error('nope')
              },
              { commit }
            )
          )
          const onError = vi.fn()
          router.onError(onError)
          await expect(router.push('/fetch')).rejects.toThrow('nope')
          expect(onError).toHaveBeenCalledTimes(1)
          expect(router.currentRoute.value.path).not.toBe('/fetch')
        })

        it(`should complete the navigation if a lazy loader throws, commit: ${commit}`, async () => {
          const { wrapper, useData, router } = singleLoaderOneRoute(
            defineLoader(
              async () => {
                throw new Error('nope')
              },
              { lazy: true, commit }
            )
          )
          await router.push('/fetch')
          expect(wrapper.get('#error').text()).toBe('Error: nope')
          expect(wrapper.get('#pending').text()).toBe('false')
          expect(wrapper.get('#data').text()).toBe('')
          expect(router.currentRoute.value.path).toBe('/fetch')
          const { data } = useData()
          expect(data.value).toEqual(undefined)
        })
      }
    )

    it('passes a signal to the loader', async () => {
      const spy = vi.fn<
        [to: RouteLocationNormalizedLoaded, context: DataLoaderContextBase],
        Promise<unknown>
      >()
      spy.mockResolvedValueOnce('ok')
      const { wrapper, useData, router } = singleLoaderOneRoute(
        defineLoader(spy)
      )
      await router.push('/fetch?p=ok')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls.at(0)?.[1]?.signal).toBeInstanceOf(AbortSignal)
    })

    it('blocks navigation by default (non lazy)', async () => {
      const [spy, resolve, reject] = mockPromise('resolved')
      const { useData, router } = singleLoaderOneRoute(defineLoader(spy))
      const p = router.push('/fetch')
      await vi.runAllTimersAsync()
      expect(spy).toHaveBeenCalled()
      const { data } = useData()
      expect(data.value).toEqual(undefined)
      expect(router.currentRoute.value.fullPath).toEqual('/')
      resolve()
      await p
      expect(router.currentRoute.value.fullPath).toEqual('/fetch')
    })

    it('does not block navigation when lazy loaded', async () => {
      const [spy, resolve, reject] = mockPromise('resolved')
      const { wrapper, useData, router } = singleLoaderOneRoute(
        defineLoader(async () => spy(), { lazy: true, key: 'lazy-test' })
      )
      expect(spy).not.toHaveBeenCalled()
      await router.push('/fetch')
      expect(router.currentRoute.value.fullPath).toEqual('/fetch')
      expect(spy).toHaveBeenCalled()
      expect(wrapper.get('#error').text()).toBe('')
      expect(wrapper.get('#pending').text()).toBe('true')
      expect(wrapper.get('#data').text()).toBe('')
      const { data } = useData()
      expect(data.value).toEqual(undefined)
      resolve()
      await vi.runAllTimersAsync()
      expect(data.value).toEqual('resolved')
      expect(wrapper.get('#pending').text()).toBe('false')
      expect(wrapper.get('#data').text()).toBe('resolved')
    })

    it('discards a pending load if a new navigation happens', async () => {
      let calls = 0
      let resolveFirstCall!: (val?: unknown) => void
      let resolveSecondCall!: (val?: unknown) => void
      const p1 = new Promise((r) => (resolveFirstCall = r))
      const p2 = new Promise((r) => (resolveSecondCall = r))
      const { wrapper, useData, router } = singleLoaderOneRoute(
        defineLoader(async (to) => {
          calls++
          if (calls === 1) {
            await p1
          } else if (calls === 2) {
            await p2
          }
          return to.query.p
        })
      )
      const firstNavigation = router.push('/fetch?p=one')
      // if we don't wait a little bit, the first navigation won't have the time to trigger the loader once
      await vi.runAllTimersAsync()
      const secondNavigation = router.push('/fetch?p=two')
      await vi.runAllTimersAsync()
      resolveSecondCall()
      await secondNavigation
      const { data } = useData()
      expect(data.value).toEqual('two')
      resolveFirstCall('ko')
      await firstNavigation
      expect(data.value).toEqual('two')
      expect(calls).toEqual(2)
    })

    it('runs nested loaders from new navigations with the correct route', async () => {
      let nestedCalls = 0
      let resolveNestedFirstCall!: (val?: unknown) => void
      let resolveNestedSecondCall!: (val?: unknown) => void
      const nestedP1 = new Promise((r) => (resolveNestedFirstCall = r))
      const nestedP2 = new Promise((r) => (resolveNestedSecondCall = r))
      const nestedLoaderSpy = vi
        .fn<[to: RouteLocationNormalizedLoaded], Promise<unknown>>()
        .mockImplementation(async (to) => {
          nestedCalls++
          if (nestedCalls === 1) {
            await nestedP1
          } else {
            await nestedP2
          }
          return to.query.p
        })
      const useNestedLoader = defineLoader(nestedLoaderSpy, {
        key: 'nested',
      })

      let rootCalls = 0
      let resolveRootFirstCall!: (val?: unknown) => void
      let resolveRootSecondCall!: (val?: unknown) => void
      const rootP1 = new Promise((r) => (resolveRootFirstCall = r))
      const rootP2 = new Promise((r) => (resolveRootSecondCall = r))

      const rootLoaderSpy = vi
        .fn<[to: RouteLocationNormalizedLoaded], Promise<unknown>>()
        .mockImplementation(async (to) => {
          rootCalls++
          const data = await useNestedLoader()
          if (rootCalls === 1) {
            await rootP1
          } else {
            await rootP2
          }
          return `${data},${to.query.p}`
        })

      const { wrapper, useData, router, app } = singleLoaderOneRoute(
        defineLoader(rootLoaderSpy, { key: 'root' })
      )
      const firstNavigation = router.push('/fetch?p=one')
      // we resolve the first root to give the nested loader a chance to run
      resolveRootFirstCall()
      // allows root loader to run
      await vi.runAllTimersAsync()

      expect(rootLoaderSpy).toHaveBeenCalledTimes(1)
      // using toHaveBeenCalledWith yields an error that is difficult to debug
      // so this is for debugging purposes
      expect(rootLoaderSpy.mock.calls.at(0)?.at(0)?.fullPath).toBe(
        '/fetch?p=one'
      )

      expect(nestedLoaderSpy).toHaveBeenCalledTimes(1)
      expect(nestedLoaderSpy.mock.calls.at(-1)?.at(0)?.fullPath).toBe(
        '/fetch?p=one'
      )

      // now trigger the second navigation while the nested loader is pending
      const secondNavigation = router.push('/fetch?p=two')
      await vi.runAllTimersAsync()

      expect(rootLoaderSpy).toHaveBeenCalledTimes(2)
      expect(rootLoaderSpy.mock.calls.at(1)?.at(0)?.fullPath).toBe(
        '/fetch?p=two'
      )

      resolveRootSecondCall()
      await vi.runAllTimersAsync()

      expect(nestedLoaderSpy).toHaveBeenCalledTimes(2)
      expect(nestedLoaderSpy.mock.calls.at(-1)?.at(0)?.fullPath).toBe(
        '/fetch?p=two'
      )

      // the nested gets called for the first time
      resolveNestedFirstCall()
      resolveNestedSecondCall()
      await vi.runAllTimersAsync()

      // explicitly wait for both navigations to ensure everything ran
      await firstNavigation
      await secondNavigation

      expect(rootCalls).toEqual(2)
      expect(nestedCalls).toEqual(2)

      // only the data from the second navigation should be preserved
      const { data } = useData()
      const { data: nestedData } = app.runWithContext(() => useNestedLoader())

      expect(nestedData.value).toEqual('two')
      expect(data.value).toEqual('two,two')
    })

    it('discards a pending load from a previous navigation that resolved later', async () => {
      let nestedCalls = 0
      let resolveNestedFirstCall!: (val?: unknown) => void
      let resolveNestedSecondCall!: (val?: unknown) => void
      const nestedP1 = new Promise((r) => (resolveNestedFirstCall = r))
      const nestedP2 = new Promise((r) => (resolveNestedSecondCall = r))
      const useNestedLoader = defineLoader(async (to) => {
        nestedCalls++
        if (nestedCalls === 1) {
          // expect(to.fullPath).toEqual('/fetch?two')
          await nestedP1
        } else {
          // since the first root resolve takes longer than the second nested resolve, the nested loader is called
          // TODO:
          // expect(to.fullPath).toEqual('/fetch?one')
          await nestedP2
        }
        return to.query.p
      })

      let rootCalls = 0
      let resolveRootFirstCall!: (val?: unknown) => void
      let resolveRootSecondCall!: (val?: unknown) => void
      const rootP1 = new Promise((r) => (resolveRootFirstCall = r))
      const rootP2 = new Promise((r) => (resolveRootSecondCall = r))

      const { wrapper, useData, router, app } = singleLoaderOneRoute(
        defineLoader(async (to) => {
          rootCalls++
          const data = await useNestedLoader()
          if (rootCalls === 1) {
            await rootP1
          } else {
            await rootP2
          }
          return `${data},${to.query.p}`
        })
      )
      const firstNavigation = router.push('/fetch?p=one')
      await vi.runAllTimersAsync()
      const secondNavigation = router.push('/fetch?p=two')
      await vi.runAllTimersAsync()
      resolveRootSecondCall()
      // the nested gets called for the first time
      resolveNestedFirstCall()

      await vi.runAllTimersAsync()
      resolveRootFirstCall()
      resolveNestedSecondCall()
      await vi.runAllTimersAsync()

      // explicitly wait for both navigations to ensure everything ran
      await firstNavigation
      await secondNavigation
      const { data } = useData()
      const { data: nestedData } = app.runWithContext(() => useNestedLoader())
      expect(data.value).toEqual('two,two')
      expect(nestedData.value).toEqual('two')

      expect(rootCalls).toEqual(2)
      // expect(nestedCalls).toEqual(2)
    })

    it('discards a pending load if trying to navigate back to the current location', async () => {
      let calls = 0
      let resolveCall1!: (val?: unknown) => void
      let resolveCall2!: (val?: unknown) => void
      let resolveCall3!: (val?: unknown) => void
      const p1 = new Promise((r) => (resolveCall1 = r))
      const p2 = new Promise((r) => (resolveCall2 = r))
      const p3 = new Promise((r) => (resolveCall3 = r))
      const spy = vi
        .fn<[to: RouteLocationNormalizedLoaded], Promise<string>>()
        .mockImplementation(async (to) => {
          calls++
          // the first one should be skipped
          if (calls === 2) {
            await p1
          } else if (calls === 3) {
            await p2
          } else if (calls === 4) {
            await p3
            // this should never happen or be used because the last navigation is considered duplicated
            return 'ko'
          }
          return to.query.p as string
        })
      const { wrapper, useData, router } = singleLoaderOneRoute(
        defineLoader(spy)
      )
      // set the initial location
      await router.push('/fetch?p=ok')

      const { data } = useData()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(data.value).toEqual('ok')

      // try running two navigations to a different location
      router.push('/fetch?p=ko')
      await vi.runAllTimersAsync()
      expect(spy).toHaveBeenCalledTimes(2)
      router.push('/fetch?p=ko')
      await vi.runAllTimersAsync()
      expect(spy).toHaveBeenCalledTimes(3)

      // but roll back to the initial one
      router.push('/fetch?p=ok')
      await vi.runAllTimersAsync()
      // it runs 3 times because in vue router, going from /fetch?p=ok to /fetch?p=ok fails right away, so the loader are never called
      // We simply don't test it because it doesn't matter, what matters is what value is preserved at the end
      // expect(spy).toHaveBeenCalledTimes(3)

      resolveCall1()
      resolveCall2()
      resolveCall3()
      await vi.runAllTimersAsync()
      await router.getPendingNavigation()

      // it preserves the initial value
      expect(data.value).toEqual('ok')
    })

    it('loader result can be awaited for the data to be ready', async () => {
      const [spy, resolve, reject] = mockPromise('resolved')

      const { wrapper, app, useData, router } = singleLoaderOneRoute(
        defineLoader(async () => spy())
      )
      router.push('/fetch')
      // ensures the useData is called first
      await vi.runAllTimersAsync()
      const useDataPromise = app.runWithContext(() => useData())
      await vi.runAllTimersAsync()
      expect(useDataPromise).toBeInstanceOf(Promise)
      resolve()
      const data = await useDataPromise
      // await router.getPendingNavigation()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(data).toEqual('resolved')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(data).toEqual('resolved')
    })

    it('can nest loaders', async () => {
      const spyOne = vi
        .fn<unknown[], Promise<string>>()
        .mockResolvedValueOnce('one')
      const spyTwo = vi
        .fn<unknown[], Promise<string>>()
        .mockResolvedValueOnce('two')
      const useLoaderOne = defineLoader(async () => spyOne())
      const useLoaderTwo = defineLoader(async () => {
        const one = await useLoaderOne()
        const two = await spyTwo()
        return `${one},${two}`
      })
      const { wrapper, useData, router } = singleLoaderOneRoute(useLoaderTwo)
      await router.push('/fetch')
      const { data } = useData()
      expect(spyOne).toHaveBeenCalledTimes(1)
      expect(spyTwo).toHaveBeenCalledTimes(1)
      expect(data.value).toEqual('one,two')
    })

    it('fetches once with lazy across components', async () => {
      const router = getRouter()
      router.addRoute({
        name: '_test',
        path: '/fetch',
        component: ComponentWithNestedLoader,
      })
      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [[DataLoaderPlugin, { router }]],
        },
      })
      const app: App = wrapper.vm.$.appContext.app

      expect(dataOneSpy).toHaveBeenCalledTimes(0)
      await router.push('/fetch')
      await vi.runOnlyPendingTimersAsync()
      expect(dataOneSpy).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toMatchInlineSnapshot('"resolved 1resolved 1"')
    })

    it(`reuses loaders when they are both nested and used in navigation`, async () => {
      const l1 = mockedLoader({ key: 'nested' })
      const rootLoader = defineLoader(
        async (to) => {
          const d = await l1.loader()
          return `${d},${to.query.p}`
        },
        { key: 'root' }
      )
      const router = getRouter()
      router.addRoute({
        name: '_test',
        path: '/fetch',
        component: defineComponent({
          setup() {
            const { data } = rootLoader()
            return { data }
          },
          template: `<p>{{ data }}</p>`,
        }),
        meta: {
          loaders: [rootLoader, l1.loader],
        },
      })
      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [[DataLoaderPlugin, { router }]],
        },
      })
      const app: App = wrapper.vm.$.appContext.app

      router.push('/fetch?p=one')
      await vi.runOnlyPendingTimersAsync()
      l1.resolve('ok')
      await vi.runOnlyPendingTimersAsync()
      // should have navigated and called the nested loader once
      expect(l1.spy).toHaveBeenCalledTimes(1)
      expect(router.currentRoute.value.fullPath).toBe('/fetch?p=one')
      expect(wrapper.text()).toBe(`ok,one`)
    })

    it(`Can use a nested loaded directly in the component`, async () => {
      const l1 = mockedLoader({ key: 'nested' })
      const rootLoader = defineLoader(
        async (to) => {
          const d = await l1.loader()
          return `${d},${to.query.p}`
        },
        { key: 'root' }
      )
      const router = getRouter()
      router.addRoute({
        name: '_test',
        path: '/fetch',
        component: defineComponent({
          setup() {
            const { data } = l1.loader()
            const { data: root } = rootLoader()
            return { root, data }
          },
          template: `<p>{{ root }} {{ data }}</p>`,
        }),
        meta: {
          loaders: [rootLoader, l1.loader],
        },
      })
      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [[DataLoaderPlugin, { router }]],
        },
      })

      router.push('/fetch?p=one')
      await vi.runOnlyPendingTimersAsync()
      l1.resolve('ok')
      await vi.runOnlyPendingTimersAsync()
      // should have navigated and called the nested loader once
      expect(l1.spy).toHaveBeenCalledTimes(1)
      expect(router.currentRoute.value.fullPath).toBe('/fetch?p=one')
      expect(wrapper.text()).toBe('ok,one ok')
    })

    it('keeps the old data until all loaders are resolved', async () => {
      const router = getRouter()
      const l1 = mockedLoader({ commit: 'after-load' })
      const l2 = mockedLoader({ commit: 'after-load' })
      router.addRoute({
        name: '_test',
        path: '/fetch',
        component: defineComponent({
          template: `<p></p>`,
        }),
        meta: {
          loaders: [l1.loader, l2.loader],
        },
      })
      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [[DataLoaderPlugin, { router }]],
        },
      })
      const app: App = wrapper.vm.$.appContext.app

      const p = router.push('/fetch')
      await vi.runOnlyPendingTimersAsync()
      l1.resolve('one')
      await vi.runOnlyPendingTimersAsync()

      const { data: one } = app.runWithContext(() => l1.loader())
      const { data: two } = app.runWithContext(() => l2.loader())
      expect(l1.spy).toHaveBeenCalledTimes(1)
      expect(l2.spy).toHaveBeenCalledTimes(1)

      // it waits for both to be resolved
      expect(one.value).toEqual(undefined)
      l2.resolve('two')
      await vi.runOnlyPendingTimersAsync()
      await p
      expect(one.value).toEqual('one')
      expect(two.value).toEqual('two')
    })

    it('awaits for a lazy loader if used as a nested loader', async () => {
      const l1 = mockedLoader({ lazy: true, key: 'nested' })
      const { wrapper, app, router, useData } = singleLoaderOneRoute(
        defineLoader(
          async (to) => {
            const data = await l1.loader()
            return `${data},${to.query.p}`
          },
          { key: 'root' }
        )
      )

      const p = router.push('/fetch?p=one')
      await vi.runOnlyPendingTimersAsync()

      const { data } = useData()
      expect(data.value).toEqual(undefined)

      l1.resolve('ok')
      await vi.runOnlyPendingTimersAsync()
      expect(data.value).toEqual('ok,one')
    })

    it('uses initialData if present', async () => {
      const spy = vi
        .fn<[to: RouteLocationNormalizedLoaded], Promise<string>>()
        .mockResolvedValue('initial')
      const { wrapper, app, router, useData } = singleLoaderOneRoute(
        defineLoader(spy, { key: 'root' }),
        {
          initialData: {
            root: 'initial',
          },
        }
      )

      await router.push('/fetch?p=one')
      const { data } = useData()
      expect(data.value).toEqual('initial')
      expect(spy).toHaveBeenCalledTimes(0)
    })

    it('ignores initialData on subsequent navigations', async () => {
      const spy = vi
        .fn<[to: RouteLocationNormalizedLoaded], Promise<string>>()
        .mockImplementation(async (to) => to.query.p as string)
      const { wrapper, app, router, useData } = singleLoaderOneRoute(
        defineLoader(spy, { key: 'root' }),
        {
          initialData: {
            root: 'initial',
          },
        }
      )

      await router.push('/fetch?p=one')
      await router.push('/fetch?p=two')
      const { data } = useData()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(data.value).toEqual('two')
    })

    it('can use initialData on nested loaders that are not exported', async () => {
      const router = getRouter()
      const l1 = mockedLoader({ key: 'root' })
      const l2 = mockedLoader({ key: 'nested' })
      router.addRoute({
        name: '_test',
        path: '/fetch',
        component: defineComponent({
          setup() {
            const { data } = l1.loader()
            const { data: nested } = l2.loader()
            return { data, nested }
          },
          template: `<p>{{ data }} {{ nested }}</p>`,
        }),
        meta: {
          loaders: [
            // we purposely only expose the 1st loader
            l1.loader,
            // l2.loader,
          ],
        },
      })
      const wrapper = mount(RouterViewMock, {
        global: {
          plugins: [
            [
              DataLoaderPlugin,
              {
                router,
                initialData: {
                  root: 'initial',
                  nested: 'nested-initial',
                },
              },
            ],
          ],
        },
      })
      const app: App = wrapper.vm.$.appContext.app

      await router.push('/fetch?p=one')
      const { data: root, pending: rootPending } = app.runWithContext(() =>
        l1.loader()
      )
      const { data: nested, pending: nestedPending } = app.runWithContext(() =>
        l2.loader()
      )
      expect(l1.spy).toHaveBeenCalledTimes(0)
      expect(l2.spy).toHaveBeenCalledTimes(0)
      expect(wrapper.text()).toBe('initial nested-initial')
      expect(root.value).toEqual('initial')
      expect(nested.value).toEqual('nested-initial')
      expect(rootPending.value).toEqual(false)
      expect(nestedPending.value).toEqual(false)
    })
  })
}
