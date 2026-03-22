import { logger, makeRequest } from '../utils.js'

export default class ExternalApiManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.externalApi

    // Deezer state
    this.deezerArls = []
    this.deezerArlIndex = 0
    this.deezerArlFailures = new Map()
    this.deezerSessions = new Map()

    // YouTube state
    this.youtubeTokens = []
    this.youtubeTokenIndex = 0
    this.youtubeTokenFailures = new Map()

    // Rip state
    this.ripTokens = []
    this._ripFetching = false
    this._ripRefreshTimer = null

    // Timers
    this._deezerRefreshTimer = null
    this._youtubeRefreshTimer = null

    // Prevent concurrent refetch
    this._deezerFetching = false
    this._youtubeFetching = false
  }

  get enabled() {
    return !!this.config?.enabled
  }

  get deezerEnabled() {
    return this.enabled && !!this.config?.deezer?.enabled
  }

  get youtubeEnabled() {
    return this.enabled && !!this.config?.youtube?.enabled
  }

  get ripEnabled() {
    return this.enabled && !!this.config?.rip?.enabled
  }

  _getHeaders() {
    const headers = {}
    if (this.config.authorization) {
      headers['Authorization'] = this.config.authorization
    }
    return headers
  }

  async initialize() {
    if (!this.enabled) return

    if (!this.config.baseUrl) {
      logger('error', 'ExternalAPI', 'External API enabled but no baseUrl configured.')
      return
    }

    if (this.deezerEnabled) {
      await this.fetchDeezerArls()
      this._startDeezerRefreshTimer()
    }

    if (this.youtubeEnabled) {
      await this.fetchYoutubeTokens()
      this._startYoutubeRefreshTimer()
    }

    if (this.ripEnabled) {
      await this.fetchRipTokens()
      this._startRipRefreshTimer()
    }
  }

  // ---- Deezer ----

  async fetchDeezerArls() {
    if (this._deezerFetching) return
    this._deezerFetching = true

    try {
      const url = `${this.config.baseUrl}/api/deezer/arls`
      const { body, error, statusCode } = await makeRequest(url, {
        method: 'GET',
        headers: this._getHeaders()
      })

      if (error || statusCode !== 200 || !body?.arls || !Array.isArray(body.arls)) {
        logger('error', 'ExternalAPI', `Failed to fetch Deezer ARLs: ${error?.message || `status ${statusCode}`}`)
        return
      }

      const now = Date.now()
      let added = 0

      for (const entry of body.arls) {
        if (!entry?.arl || typeof entry.arl !== 'string') continue
        if (!entry?.api_key || typeof entry.api_key !== 'string') continue

        // check if license is a JSON string containing "license_token" (possibly nested)
        if (entry?.license && typeof entry.license === 'string' && entry.license.startsWith('{')) {
            try {
                const parsed = JSON.parse(entry.license)
                const token = parsed.license_token || parsed.LICENCE?.OPTIONS?.license_token

                if (token) {
                    entry.license = token
                } else {
                    logger('warn', 'ExternalAPI', `Deezer ARL entry has invalid license format, missing "license_token" field: ${entry.arl.slice(0, 8)}...`)
                    continue
                }
            } catch (e) {
                logger('warn', 'ExternalAPI', `Deezer ARL entry has invalid license format, not a valid JSON: ${entry.arl.slice(0, 8)}...`)
                continue
            }
        }

        if (!entry?.license || typeof entry.license !== 'string') {
            if (this.nodelink.options.sources.deezer.decryptionKey) {
                entry.license = this.nodelink.options.sources.deezer.decryptionKey
            } else {
                continue
            }
        }

        // Skip expired entries
        if (entry.expires_at && new Date(entry.expires_at).getTime() <= now) continue

        if (!this.deezerSessions.has(entry.arl)) {
          this.deezerSessions.set(entry.arl, {
            licenseToken: entry.license,
            csrfToken: entry.api_key,
            cookie: `arl=${entry.arl}`,
            expiresAt: entry.expires_at ? new Date(entry.expires_at).getTime() : null
          })

          if (!this.deezerArls.includes(entry.arl)) {
            this.deezerArls.push(entry.arl)
            added++
          }
        }
      }

      logger('info', 'ExternalAPI', `Fetched Deezer ARLs from external API (${added} new). Pool size: ${this.deezerArls.length}`)
    } catch (e) {
      logger('error', 'ExternalAPI', `Error fetching Deezer ARLs: ${e.message}`)
    } finally {
      this._deezerFetching = false
    }
  }

  getDeezerSession() {
    if (this.deezerArls.length === 0) return null

    // Remove expired sessions lazily
    const now = Date.now()
    while (this.deezerArls.length > 0) {
      const idx = this.deezerArlIndex % this.deezerArls.length
      const arl = this.deezerArls[idx]
      const session = this.deezerSessions.get(arl)

      if (!session || (session.expiresAt && session.expiresAt <= now)) {
        this._removeDeezerArl(arl)
        continue
      }

      this.deezerArlIndex = (idx + 1) % this.deezerArls.length
      return { arl, ...session }
    }

    return null
  }

  _removeDeezerArl(arl) {
    this.deezerArls = this.deezerArls.filter(a => a !== arl)
    this.deezerSessions.delete(arl)
    this.deezerArlFailures.delete(arl)

    if (this.deezerArls.length > 0) {
      this.deezerArlIndex = this.deezerArlIndex % this.deezerArls.length
    } else {
      this.deezerArlIndex = 0
    }
  }

  async reportDeezerArlFailure(arl) {
    const count = (this.deezerArlFailures.get(arl) || 0) + 1
    this.deezerArlFailures.set(arl, count)

    const threshold = this.config.deezer?.failureThreshold || 3

    logger('warn', 'ExternalAPI', `Deezer ARL ${arl.slice(0, 8)}... failure count: ${count}/${threshold}`)

    if (count >= threshold) {
      this._removeDeezerArl(arl)

      logger('warn', 'ExternalAPI', `Removed Deezer ARL ${arl.slice(0, 8)}... from rotation. Pool size: ${this.deezerArls.length}`)

      await this._reportDeezerArlToApi(arl)
      this._checkDeezerPool()
    }
  }

  async _reportDeezerArlToApi(arl) {
    try {
      const url = `${this.config.baseUrl}/api/deezer/report`
      const { error, statusCode } = await makeRequest(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: { arl }
      })

      if (error || (statusCode !== 200 && statusCode !== 204)) {
        logger('warn', 'ExternalAPI', `Failed to report Deezer ARL failure: ${error?.message || `status ${statusCode}`}`)
      } else {
        logger('info', 'ExternalAPI', `Reported Deezer ARL failure to external API: ${arl.slice(0, 8)}...`)
      }
    } catch (e) {
      logger('warn', 'ExternalAPI', `Error reporting Deezer ARL failure: ${e.message}`)
    }
  }

  _checkDeezerPool() {
    const poolMinSize = this.config.deezer?.poolMinSize || 2

    if (this.deezerArls.length < poolMinSize) {
      logger('info', 'ExternalAPI', `Deezer ARL pool below minimum (${this.deezerArls.length}/${poolMinSize}), fetching new ARLs...`)
      this.fetchDeezerArls()
    }
  }

  _startDeezerRefreshTimer() {
    const refreshInterval = this.config.deezer?.refreshIntervalMs || 60 * 60 * 1000

    this._deezerRefreshTimer = setInterval(() => {
      this.fetchDeezerArls()
    }, refreshInterval)
  }

  // ---- YouTube ----

  async fetchYoutubeTokens() {
    if (this._youtubeFetching) return
    this._youtubeFetching = true

    try {
      const url = `${this.config.baseUrl}/api/youtube/tokens`
      const { body, error, statusCode } = await makeRequest(url, {
        method: 'GET',
        headers: this._getHeaders()
      })

      if (error || statusCode !== 200 || !body?.tokens || !Array.isArray(body.tokens)) {
        logger('error', 'ExternalAPI', `Failed to fetch YouTube tokens: ${error?.message || `status ${statusCode}`}`)
        return
      }

      const now = Date.now()
      const validTokens = []

      for (const entry of body.tokens) {
        if (!entry?.access_token || typeof entry.access_token !== 'string') continue

        // Skip expired tokens
        if (entry.expires_at && new Date(entry.expires_at).getTime() <= now) continue

        validTokens.push({
          accessToken: entry.access_token,
          expiresAt: entry.expires_at ? new Date(entry.expires_at).getTime() : null
        })
      }

      this.youtubeTokens = validTokens
      this.youtubeTokenIndex = 0
      this.youtubeTokenFailures.clear()

      logger('info', 'ExternalAPI', `Fetched ${this.youtubeTokens.length} YouTube tokens from external API.`)
    } catch (e) {
      logger('error', 'ExternalAPI', `Error fetching YouTube tokens: ${e.message}`)
    } finally {
      this._youtubeFetching = false
    }
  }

  getYoutubeToken() {
    if (this.youtubeTokens.length === 0) return null

    // Remove expired tokens lazily
    const now = Date.now()
    while (this.youtubeTokens.length > 0) {
      const idx = this.youtubeTokenIndex % this.youtubeTokens.length
      const entry = this.youtubeTokens[idx]

      if (entry.expiresAt && entry.expiresAt <= now) {
        this.youtubeTokens.splice(idx, 1)
        this.youtubeTokenFailures.delete(entry.accessToken)
        if (this.youtubeTokens.length > 0) {
          this.youtubeTokenIndex = this.youtubeTokenIndex % this.youtubeTokens.length
        } else {
          this.youtubeTokenIndex = 0
        }
        continue
      }

      this.youtubeTokenIndex = (idx + 1) % this.youtubeTokens.length
      return entry.accessToken
    }

    return null
  }

  async reportYoutubeTokenFailure(accessToken) {
    const count = (this.youtubeTokenFailures.get(accessToken) || 0) + 1
    this.youtubeTokenFailures.set(accessToken, count)

    const threshold = this.config.deezer?.failureThreshold || 3

    logger('warn', 'ExternalAPI', `YouTube token ${accessToken.slice(0, 8)}... failure count: ${count}/${threshold}`)

    if (count >= threshold) {
      this.youtubeTokens = this.youtubeTokens.filter(t => t.accessToken !== accessToken)
      this.youtubeTokenFailures.delete(accessToken)

      if (this.youtubeTokens.length > 0) {
        this.youtubeTokenIndex = this.youtubeTokenIndex % this.youtubeTokens.length
      } else {
        this.youtubeTokenIndex = 0
      }

      logger('warn', 'ExternalAPI', `Removed YouTube token ${accessToken.slice(0, 8)}... from rotation. Pool size: ${this.youtubeTokens.length}`)

      await this._reportYoutubeTokenToApi(accessToken)
      this._checkYoutubePool()
    }
  }

  async _reportYoutubeTokenToApi(accessToken) {
    try {
      const url = `${this.config.baseUrl}/api/youtube/tokens`
      const { error, statusCode } = await makeRequest(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: { access_token: accessToken }
      })

      if (error || (statusCode !== 200 && statusCode !== 204)) {
        logger('warn', 'ExternalAPI', `Failed to report YouTube token failure: ${error?.message || `status ${statusCode}`}`)
      } else {
        logger('info', 'ExternalAPI', `Reported YouTube token failure to external API: ${accessToken.slice(0, 8)}...`)
      }
    } catch (e) {
      logger('warn', 'ExternalAPI', `Error reporting YouTube token failure: ${e.message}`)
    }
  }

  _checkYoutubePool() {
    if (this.youtubeTokens.length === 0) {
      logger('info', 'ExternalAPI', 'YouTube token pool empty, fetching new tokens...')
      this.fetchYoutubeTokens()
    }
  }

  _startYoutubeRefreshTimer() {
    const refreshInterval = this.config.youtube?.refreshIntervalMs || 20 * 60 * 60 * 1000

    this._youtubeRefreshTimer = setInterval(() => {
      this.fetchYoutubeTokens()
    }, refreshInterval)
  }

  // ---- Rip ----

  async fetchRipTokens() {
    if (this._ripFetching) return
    this._ripFetching = true

    try {
      const url = `${this.config.baseUrl}/api/rip/tokens`
      const { body, error, statusCode } = await makeRequest(url, {
        method: 'GET',
        headers: this._getHeaders()
      })

      if (error || statusCode !== 200 || !body?.tokens || !Array.isArray(body.tokens)) {
        logger('error', 'ExternalAPI', `Failed to fetch Rip tokens: ${error?.message || `status ${statusCode}`}`)
        return
      }

      const now = Date.now()
      const validTokens = []

      for (const entry of body.tokens) {
        if (!entry?.access_token || typeof entry.access_token !== 'string') continue
        if (!entry?.api_url) continue

        const expiresAt = entry.expires_at ? new Date(entry.expires_at).getTime() : null
        if (expiresAt && expiresAt <= now) continue

        validTokens.push({
          token: entry.access_token,
          expiresAt,
          apiUrl: entry.api_url,
          environment: entry.environment || ''
        })
      }

      this.ripTokens = validTokens

      const devCount = validTokens.filter(t => t.environment === 'dev').length
      logger('info', 'ExternalAPI', `Fetched ${validTokens.length} Rip tokens (main: ${validTokens.length - devCount}, dev: ${devCount}).`)
    } catch (e) {
      logger('error', 'ExternalAPI', `Error fetching Rip tokens: ${e.message}`)
    } finally {
      this._ripFetching = false
    }
  }

  getRipToken(type) {
    const now = Date.now()

    // Filter valid, non-expired tokens
    let candidates = this.ripTokens.filter(t => {
      if (t.expiresAt && t.expiresAt <= now) return false
      if (type === 'dev') return t.environment === 'dev'
      if (type === 'main') return t.environment !== 'dev'
      return true
    })

    if (candidates.length === 0) {
      // Try any valid token
      candidates = this.ripTokens.filter(t => !t.expiresAt || t.expiresAt > now)
    }

    if (candidates.length === 0) {
      // Trigger async refetch
      this.fetchRipTokens()
      return null
    }

    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  _startRipRefreshTimer() {
    const refreshInterval = this.config.rip?.refreshIntervalMs || 30 * 60 * 1000

    this._ripRefreshTimer = setInterval(() => {
      this.fetchRipTokens()
    }, refreshInterval)
  }

  // ---- Cleanup ----

  stop() {
    if (this._deezerRefreshTimer) {
      clearInterval(this._deezerRefreshTimer)
      this._deezerRefreshTimer = null
    }
    if (this._youtubeRefreshTimer) {
      clearInterval(this._youtubeRefreshTimer)
      this._youtubeRefreshTimer = null
    }
    if (this._ripRefreshTimer) {
      clearInterval(this._ripRefreshTimer)
      this._ripRefreshTimer = null
    }
  }
}
