/* eslint-env mocha */

const path = require('path')
const should = require('should')
const fs = require('fs-extra')
const os = require('os')

const configHelpers = require('../support/helpers/config')
const { COZY_URL } = require('../support/helpers/cozy')

const Config = require('../../core/config')
const TMP_CONFIG_PATH = path.join(os.tmpdir(), 'cozy-desktop', 'config.json')

describe('Config', function () {
  beforeEach('instanciate config', configHelpers.createConfig)
  afterEach('clean config directory', configHelpers.cleanConfig)

  describe('import', function () {
    context('when a tmp config file exists', function () {
      beforeEach('create tmp config file', function () {
        fs.ensureFileSync(TMP_CONFIG_PATH)
      })
      afterEach('remove tmp config file', function () {
        if (fs.existsSync(TMP_CONFIG_PATH)) {
          fs.unlinkSync(TMP_CONFIG_PATH)
        }
      })

      context('and it has a valid JSON content', function () {
        const configPath = path.join(os.tmpdir(), 'cozy-desktop-test', '_config.json')
        const config = {
          'configPath': configPath,
          'url': 'https://cozy.test/'
        }

        beforeEach('write valid content', function () {
          fs.writeFileSync(TMP_CONFIG_PATH, JSON.stringify(config, null, 2))
        })
        beforeEach('create special config file', function () {
          fs.ensureFileSync(configPath)
        })
        afterEach('remove special config file', function () {
          fs.unlinkSync(configPath)
        })

        it('imports the tmp config', function () {
          should(Config.import(TMP_CONFIG_PATH)).match(config)
        })

        it('persists the tmp config file as the new config file', function () {
          Config.import(TMP_CONFIG_PATH)

          const persistedConfig = require(config.configPath)
          should(persistedConfig).match(config)
        })
      })

      context('and it does not have a valid JSON content', function () {
        beforeEach('write invalid content', function () {
          fs.writeFileSync(TMP_CONFIG_PATH, '\0')
          this.config.persist()
        })

        it('imports the existing config', function () {
          const config = Config.import(this.config.configPath)
          should(config).be.an.Object()
          should(config.url).eql(COZY_URL)
        })
      })
    })

    context('when no tmp config files exist', function () {
      beforeEach('remove any tmp config file', function () {
        if (fs.existsSync(TMP_CONFIG_PATH)) {
          fs.unlinkSync(TMP_CONFIG_PATH)
        }
        this.config.persist()
      })

      it('imports the existing config', function () {
        const config = Config.import(this.config.configPath)
        should(config).be.an.Object()
        should(config.url).eql(COZY_URL)
      })
    })

    context('when the imported config is empty', function () {
      beforeEach('empty local config', function () {
        fs.ensureFileSync(this.config.configPath)
        fs.writeFileSync(this.config.configPath, '')
      })

      it('creates a new empty one', function () {
        const config = Config.import(this.config.configPath)
        should(config).be.an.Object()
        should(config).be.empty()
      })
    })
  })

  describe('safeLoad', function () {
    context('when the file content is valid JSON', function () {
      const conf = { 'url': 'https://cozy.test/' }

      beforeEach('write valid content', function () {
        fs.writeFileSync(this.config.configPath, JSON.stringify(conf, null, 2))
      })

      it('returns an object matching the file content', function () {
        const newConf = Config.safeLoad(this.config.configPath)
        newConf.should.be.an.Object()
        newConf.url.should.eql(conf.url)
      })
    })

    context('when the file does not exist', function () {
      beforeEach('remove config file', function () {
        if (fs.existsSync(this.config.configPath)) {
          fs.unlinkSync(this.config.configPath)
        }
      })

      it('throws an error', function () {
        (() => {
          Config.safeLoad(this.config.configPath)
        }).should.throw()
      })
    })

    context('when the file content is not valid JSON', function () {
      beforeEach('write invalid content', function () {
        fs.writeFileSync(this.config.configPath, '\0')
      })

      it('does not throw any errors', function () {
        (() => {
          Config.safeLoad(this.config.configPath)
        }).should.not.throw()
      })

      it('returns an empty object', function () {
        const config = Config.safeLoad(this.config.configPath)
        should(config).be.an.Object()
        should(config).be.empty()
      })

      it('deletes the file', function () {
        fs.existsSync(this.config.configPath).should.be.true()
        Config.safeLoad(this.config.configPath)
        fs.existsSync(this.config.configPath).should.be.false()
      })
    })
  })

  describe('persist', function () {
    it('saves last changes made on the config', function () {
      const url = 'http://cozy.local:8080/'
      this.config.cozyUrl = url
      this.config.persist()
      let conf = new Config(path.dirname(this.config.configPath))
      should(conf.cozyUrl).equal(url)
    })
  })

  describe('SyncPath', function () {
    it('returns the set sync path', function () {
      this.config.syncPath = '/path/to/sync/dir'
      should(this.config.syncPath).equal('/path/to/sync/dir')
    })
  })

  describe('CozyUrl', function () {
    it('returns the set Cozy URL', function () {
      this.config.cozyUrl = 'https://cozy.example.com'
      should(this.config.cozyUrl).equal('https://cozy.example.com')
    })
  })

  describe('gui', () => {
    it('returns an empty hash by default', function () {
      should(this.config.gui).deepEqual({})
    })

    it('returns GUI configuration if any', function () {
      const guiConfig = {foo: 'bar'}
      this.config.config.gui = guiConfig
      should(this.config.gui).deepEqual(guiConfig)
    })
  })

  describe('Client', function () {
    it('can set a client', function () {
      this.config.client = { clientName: 'test' }
      should(this.config.isValid()).be.true()
      should(this.config.client.clientName).equal('test')
    })

    it('has no client after a reset', function () {
      this.config.reset()
      should(this.config.isValid()).be.false()
    })
  })

  describe('saveMode', function () {
    it('sets the pull or push mode', function () {
      this.config.saveMode('push')
      should(this.config.config.mode).equal('push')
    })

    it('throws an error for incompatible mode', function () {
      this.config.saveMode('push')
      should.throws(() => this.config.saveMode('pull'), /you cannot switch/)
      should.throws(() => this.config.saveMode('full'), /you cannot switch/)
    })
  })
})
