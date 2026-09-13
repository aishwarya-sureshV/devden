import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatSessionModelName,
  sessionDisplayModel,
  sessionFilterCatalog,
  sessionMatchesFilters,
  sessionMetaLine,
  sessionUsesModel,
  uniqueSessionModels,
} from './sessionModels.ts'

describe('formatSessionModelName', () => {
  it('labels DeepSeek V4 Pro from the ollama id', () => {
    assert.equal(formatSessionModelName('deepseek-v4-pro:cloud'), 'DeepSeek V4 Pro')
  })

  it('labels other common session models', () => {
    assert.equal(formatSessionModelName('glm-5.3-flash:cloud'), 'GLM 5.3 Flash')
    assert.equal(formatSessionModelName('claude-sonnet-5'), 'Claude Sonnet 5')
  })
})

describe('sessionUsesModel', () => {
  it('matches a model used for one turn even when it is not lastModel', () => {
    const session = {
      lastModel: 'glm-5.3-flash:cloud',
      models: ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'],
    }
    assert.equal(sessionUsesModel(session, 'deepseek-v4-pro:cloud'), true)
    assert.equal(sessionUsesModel(session, 'glm-5.3-flash:cloud'), true)
    assert.equal(sessionUsesModel(session, 'kimi-k3:cloud'), false)
  })

  it('falls back to lastModel when models is missing', () => {
    assert.equal(sessionUsesModel({ lastModel: 'deepseek-v4-pro:cloud' }, 'deepseek-v4-pro:cloud'), true)
  })
})

describe('uniqueSessionModels', () => {
  it('lists DeepSeek when it appears on any session', () => {
    const options = uniqueSessionModels([
      { lastModel: 'glm-5.3-flash:cloud', models: ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'] },
      { lastModel: 'deepseek-v4-pro:cloud', models: ['deepseek-v4-pro:cloud'] },
    ])
    assert.deepEqual(options.map((option) => option.id).sort(), ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'])
    assert.equal(options.find((option) => option.id === 'deepseek-v4-pro:cloud')?.label, 'DeepSeek V4 Pro')
  })
})

describe('sessionDisplayModel', () => {
  it('prefers the last ollama model over a generic pi-local label', () => {
    assert.equal(
      sessionDisplayModel({
        lastModel: 'pi-local',
        lastModelProvider: 'ollama',
        models: ['pi-local', 'deepseek-v4-pro:cloud'],
      }),
      'deepseek-v4-pro:cloud',
    )
  })

  it('keeps a real lastModel even when older models exist', () => {
    assert.equal(
      sessionDisplayModel({
        lastModel: 'glm-5.3-flash:cloud',
        lastModelProvider: 'ollama',
        models: ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'],
      }),
      'glm-5.3-flash:cloud',
    )
  })
})

describe('sessionMetaLine', () => {
  it('shows the formatted last model and full effort word', () => {
    assert.equal(
      sessionMetaLine({
        backend: 'pi',
        lastModel: 'deepseek-v4-pro:cloud',
        lastModelProvider: 'ollama',
        lastEffort: 'medium',
        models: ['deepseek-v4-pro:cloud'],
      }),
      'DeepSeek V4 Pro · medium',
    )
  })
})

describe('sessionFilterCatalog', () => {
  it('groups last-used models under each backend', () => {
    const catalog = sessionFilterCatalog([
      { backend: 'pi', lastModel: 'deepseek-v4-pro:cloud', models: ['deepseek-v4-pro:cloud'] },
      { backend: 'pi', lastModel: 'pi-local', models: ['glm-5.3-flash:cloud'] },
      { backend: 'claude', lastModel: 'claude-sonnet-4.5', models: ['claude-sonnet-4.5'] },
    ])
    const pi = catalog.find((group) => group.backend === 'pi')
    const claude = catalog.find((group) => group.backend === 'claude')
    assert.equal(pi?.count, 2)
    assert.equal(pi?.models.find((model) => model.id === 'deepseek-v4-pro:cloud')?.count, 1)
    assert.equal(pi?.models.find((model) => model.id === 'glm-5.3-flash:cloud')?.count, 1)
    assert.equal(claude?.count, 1)
  })
})

describe('sessionMatchesFilters', () => {
  it('matches a backend filter and a last-model filter', () => {
    const session = {
      backend: 'pi' as const,
      lastModel: 'deepseek-v4-pro:cloud',
      models: ['deepseek-v4-pro:cloud'],
    }
    assert.equal(sessionMatchesFilters(session, new Set(['pi']), new Set()), true)
    assert.equal(sessionMatchesFilters(session, new Set(['claude']), new Set()), false)
    assert.equal(
      sessionMatchesFilters(session, new Set(['pi']), new Set(['deepseek-v4-pro:cloud'])),
      true,
    )
    assert.equal(
      sessionMatchesFilters(session, new Set(['pi']), new Set(['glm-5.3-flash:cloud'])),
      false,
    )
  })
})
