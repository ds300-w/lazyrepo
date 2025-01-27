import { makeConfigFile, runIntegrationTest } from './runIntegrationTests.js'

test('excludes take precedence', async () => {
  await runIntegrationTest(
    {
      packageManager: 'npm',
      workspaceGlobs: ['packages/*'],
      structure: {
        'lazy.config.js': makeConfigFile({
          baseCacheConfig: {
            include: ['<rootDir>/scripts/**/*'],
            exclude: ['scripts/tsconfig.tsbuildinfo'],
          },
          scripts: {
            build: {
              cache: {
                inputs: ['scripts/build.js'],
              },
              execution: 'top-level',
              baseCommand: 'node scripts/build.js > .out.txt',
            },
          },
        }),
        scripts: {
          'build.js': 'console.log("hello")',
          'tsconfig.tsbuildinfo': 'blah',
        },
        packages: {},
      },
    },
    async (t) => {
      const firstRun = await t.exec(['build'])

      expect(firstRun.status).toBe(0)
      expect(firstRun.output).toMatchInlineSnapshot(`
        "lazyrepo 0.0.0-test
        -------------------
        Loaded config file: lazy.config.js

        build::<rootDir> finding files matching scripts/**/* took 1.00s
        build::<rootDir> finding files matching scripts/build.js took 1.00s
        build::<rootDir> hashed 1/1 files in 1.00s
        build::<rootDir> cache miss, no previous manifest found
        build::<rootDir> RUN node scripts/build.js > .out.txt in 
        build::<rootDir> input manifest: .lazy/build/manifest.tsv
        build::<rootDir> ✔ done in 1.00s

             Tasks:  1 successful, 1 total
            Cached:  0/1 cached
              Time:  1.00s

        "
      `)

      expect(t.read('.out.txt')).toMatchInlineSnapshot(`
        "hello
        "
      `)

      expect(t.read('.lazy/build/manifest.tsv').includes('tsconfig.tsbuildinfo')).toBeFalsy()
      expect(t.read('.lazy/build/manifest.tsv').includes('build.js')).toBeTruthy()
    },
  )
})
