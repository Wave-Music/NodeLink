import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger, makeRequest, getBestMatch } from '../utils.js'

export default class RipSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.sourceConfig = nodelink.options.sources?.rip || {}

    const urlPattern = this.sourceConfig.urlPattern
    this.patterns = urlPattern ? [new RegExp(urlPattern, 'i')] : []
    this.searchTerms = this.sourceConfig.searchPrefix ? [this.sourceConfig.searchPrefix] : []
    this.recommendationTerm = this.sourceConfig.recommendationPrefix ? [this.sourceConfig.recommendationPrefix] : []
    this.priority = 80

    this._typeMap = this.sourceConfig.typeMap || {}
    this._apiPaths = this.sourceConfig.apiPaths || {}
    this._linkPaths = this.sourceConfig.linkPaths || {}
    this._cdnPaths = this.sourceConfig.cdnPaths || {}
    this._fields = this.sourceConfig.fields || {}
    this._playBody = this.sourceConfig.playBody || {}
    this._streamParamName = this.sourceConfig.streamParamName || ''
  }

  _resolvePath(obj, path) {
    if (!path || obj == null) return undefined
    const parts = path.split('.')
    let current = obj
    for (const part of parts) {
      if (current == null) return undefined
      current = current[part]
    }
    return current
  }

  _f(obj, fieldKey, defaultVal = null) {
    const mapping = this._fields[fieldKey]
    if (!mapping) return defaultVal
    const paths = Array.isArray(mapping) ? mapping : [mapping]
    for (const path of paths) {
      const val = this._resolvePath(obj, path)
      if (val !== undefined && val !== null) return val
    }
    return defaultVal
  }

  _tpl(template, vars) {
    if (!template) return ''
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')
  }

  _buildApiPath(type, vars) {
    return this._tpl(this._apiPaths[type], vars)
  }

  _buildLink(type, vars) {
    const template = this._linkPaths[type]
    if (!template) return ''
    return (this.sourceConfig.linkBase || '') + this._tpl(template, vars)
  }

  _buildCdn(type, vars) {
    const template = this._cdnPaths[type]
    if (!template) return null
    const base = this.sourceConfig.cdnBase || ''
    if (!base) return null
    return base + this._tpl(template, vars)
  }

  async setup() {
    if (!this.sourceConfig.linkBase || !this.sourceConfig.privateApiBase) {
      logger('warn', 'Sources', 'Rip source missing required config (linkBase, privateApiBase). Skipping.')
      return false
    }

    if (!this.nodelink.externalApiManager?.ripEnabled) {
      logger('warn', 'Sources', 'Rip source requires externalApi.rip to be enabled for token management. Skipping.')
      return false
    }

    logger('info', 'Sources', 'Loaded Rip source.')
    return true
  }

  _getApiBase(isDev) {
    return isDev ? (this.sourceConfig.devApiBase || this.sourceConfig.privateApiBase) : this.sourceConfig.privateApiBase
  }

  _getLinkBase(isDev) {
    return isDev ? (this.sourceConfig.devLinkBase || this.sourceConfig.linkBase) : this.sourceConfig.linkBase
  }

  _getOrigin(isDev) {
    const base = this._getLinkBase(isDev)
    return base.endsWith('/') ? base.slice(0, -1) : base
  }

  _getToken(type) {
    return this.nodelink.externalApiManager.getRipToken(type)
  }

  async _apiRequest(url, { authorization = false, body = null, tokenType = null } = {}) {
    const headers = {
      'User-Agent': this.sourceConfig.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }

    if (authorization) {
      const tokenData = this._getToken(tokenType)
      if (!tokenData || !tokenData.token) {
        throw new Error('Failed to get access token')
      }
      headers['Authorization'] = `Bearer ${tokenData.token}`
    }

    const options = {
      method: body ? 'POST' : 'GET',
      headers
    }

    if (body) {
      options.body = body
      options.disableBodyCompression = true
    }

    const { body: responseBody, error, statusCode } = await makeRequest(url, options)

    if (error) throw error
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`API request failed with status ${statusCode}`)
    }

    return responseBody
  }

  async _apiRequestWithFallback(path, { authorization = false, body = null } = {}) {
    const privateBase = this.sourceConfig.privateApiBase
    const devBase = this.sourceConfig.devApiBase

    // Try primary (private) first
    try {
      const json = await this._apiRequest(`${privateBase}${path}`, {
        authorization,
        body,
        tokenType: 'main'
      })
      if (json) return json
    } catch (e) {
      if (devBase) {
        logger('debug', 'Sources', `[Rip] Primary API failed for ${path}, trying dev fallback: ${e.message}`)
      } else {
        throw e
      }
    }

    // Try dev fallback
    if (devBase) {
      const json = await this._apiRequest(`${devBase}${path}`, {
        authorization,
        body,
        tokenType: 'dev'
      })
      return json
    }

    return null
  }

  async search(query, _sourceTerm) {
    const searchApiBase = this.sourceConfig.searchApiBase
    if (!searchApiBase) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const searchPath = this._buildApiPath('search', { query: encodeURIComponent(query), limit: '20' })
      const url = `${searchApiBase}${searchPath}`
      const json = await this._apiRequest(url, { authorization: false })

      const tracks = this._f(json, 'searchTracks')
      if (!tracks?.length) {
        return { loadType: 'empty', data: {} }
      }

      const parsed = this._parseTracks(tracks)
      if (!parsed.length) return { loadType: 'empty', data: {} }

      return { loadType: 'search', data: parsed }
    } catch (e) {
      logger('error', 'Sources', `[Rip] Search failed: ${e.message}`)
      return { exception: { message: 'Search failed.', severity: 'common' } }
    }
  }

  async resolve(queryUrl) {
    if (!this.patterns.length) return null

    const match = queryUrl.match(this.patterns[0])
    if (!match?.groups) return null

    const id = match.groups.identifier
    const type = match.groups.type
    const internalType = this._typeMap[type]
    if (!internalType) return null

    try {
      switch (internalType) {
        case 'album':
          return await this._getAlbum(id)
        case 'playlist':
          return await this._getPlaylist(id)
        case 'artist':
          return await this._getArtist(id)
        case 'track':
          return await this._getTrack(id)
        default:
          return null
      }
    } catch (e) {
      logger('error', 'Sources', `[Rip] Resolve failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'common' } }
    }
  }

  async _getTrack(id) {
    const path = this._buildApiPath('track', { id })
    const json = await this._apiRequestWithFallback(path, { authorization: false })
    if (!json) return { loadType: 'empty', data: {} }

    const track = this._parseTrack(json)
    if (!track) return { loadType: 'empty', data: {} }

    return { loadType: 'track', data: track }
  }

  async _getAlbum(id) {
    const path = this._buildApiPath('album', { id })
    const json = await this._apiRequestWithFallback(path, { authorization: false })
    if (!json) return { loadType: 'empty', data: {} }

    const tracks = this._parseTracks(this._f(json, 'albumTracks', []))
    const albumId = this._f(json, 'albumId') || id

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: this._f(json, 'albumTitle', 'Unknown Album'),
          selectedTrack: -1
        },
        pluginInfo: {
          type: 'album',
          url: this._buildLink('album', { id: albumId }),
          artworkUrl: this._f(json, 'albumArtwork'),
          author: this._f(json, 'albumAuthor', 'Unknown Artist'),
          totalTracks: this._f(json, 'albumTrackCount') || tracks.length
        },
        tracks
      }
    }
  }

  async _getPlaylist(id) {
    const path = this._buildApiPath('playlist', { id })
    const json = await this._apiRequestWithFallback(path, { authorization: true })
    if (!json) return { loadType: 'empty', data: {} }

    let tracks = []
    const trackCount = this._f(json, 'playlistTrackCount', 0)
    if (trackCount > 0) {
      const tracksPath = this._buildApiPath('playlistTracks', { id })
      const tracksJson = await this._apiRequestWithFallback(tracksPath, { authorization: true })
      const tracksData = this._f(tracksJson, 'playlistTracksData')
      if (tracksData) {
        tracks = this._parseTracks(tracksData)
      }
    }

    const playlistId = this._f(json, 'playlistId') || id
    const thumbnail = this._f(json, 'playlistThumbnail')

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: this._f(json, 'playlistTitle', 'Unknown Playlist'),
          selectedTrack: -1
        },
        pluginInfo: {
          type: 'playlist',
          url: this._buildLink('playlist', { id: playlistId }),
          artworkUrl: this._buildCdn('playlistArt', { id: playlistId, thumbnail }),
          author: 'Unknown Author',
          totalTracks: trackCount || tracks.length
        },
        tracks
      }
    }
  }

  async _getArtist(id) {
    const path = this._buildApiPath('artistProfile', { id })
    const json = await this._apiRequestWithFallback(path, { authorization: true })
    if (!json) return { loadType: 'empty', data: {} }

    const artistName = this._f(json, 'artistName', 'Unknown Artist')
    const artistId = this._f(json, 'artistId') || id
    const tracks = this._parseTracks(this._f(json, 'artistTopTracks', []))

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: `${artistName}'s Top Tracks`,
          selectedTrack: -1
        },
        pluginInfo: {
          type: 'artist',
          url: this._buildLink('artist', { id: artistId }),
          artworkUrl: this._f(json, 'artistAvatar'),
          author: artistName,
          totalTracks: tracks.length
        },
        tracks
      }
    }
  }

  _parseTracks(arr) {
    const tracks = []
    if (!Array.isArray(arr)) return tracks
    for (const item of arr) {
      const t = this._parseTrack(item)
      if (t) tracks.push(t)
    }
    return tracks
  }

  _parseTrack(json) {
    if (!json) return null
    if (this._f(json, 'playable') === false) return null

    const author = this._f(json, 'author', 'Unknown Artist')
    const authorId = this._f(json, 'authorId', '')
    const trackId = this._f(json, 'trackId', '')
    const trackIdForUri = this._f(json, 'trackIdForUri', '')

    const trackInfo = {
      identifier: trackId,
      title: this._f(json, 'title', 'Unknown Title'),
      author,
      length: this._f(json, 'duration', 0),
      sourceName: 'rip',
      artworkUrl: this._f(json, 'artwork'),
      uri: this._buildLink('track', { id: trackIdForUri }),
      isStream: false,
      isSeekable: true,
      position: 0,
      isrc: this._f(json, 'isrc')
    }

    const releaseId = this._f(json, 'releaseId')

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {
        albumName: this._f(json, 'releaseTitle'),
        albumUrl: releaseId ? this._buildLink('album', { id: releaseId }) : null,
        artistUrl: authorId ? this._buildLink('artist', { id: authorId }) : null,
        artistArtworkUrl: this._f(json, 'authorAvatar')
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    const privateBase = this.sourceConfig.privateApiBase
    const devBase = this.sourceConfig.devApiBase
    const userAgent = this.sourceConfig.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    const playPath = this._buildApiPath('play', { id: decodedTrack.identifier })

    const tryEndpoint = async (apiBase, isDev) => {
      const tokenData = this._getToken(isDev ? 'dev' : 'main')
      if (!tokenData?.token) return null

      const origin = this._getOrigin(isDev)
      const referer = this._getLinkBase(isDev)

      const { body, error } = await makeRequest(`${apiBase}${playPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.token}`,
          'Origin': origin,
          'Referer': referer,
          'User-Agent': userAgent
        },
        body: this._playBody,
        disableBodyCompression: true
      })

      if (error) return null
      const url = this._f(body, 'playUrl')
      if (!url) return null
      return { ...body, _resolvedUrl: url }
    }

    // Randomly pick an endpoint to start with, fall back to other
    const tryDev = Math.random() < 0.5
    let sourceData = await tryEndpoint(tryDev ? (devBase || privateBase) : privateBase, tryDev && !!devBase)

    if (!sourceData?._resolvedUrl) {
      sourceData = await tryEndpoint(!tryDev ? (devBase || privateBase) : privateBase, !tryDev && !!devBase)
    }

    if (!sourceData?._resolvedUrl) {
      const searchResult = await this.nodelink.sources.searchWithDefault(
        `${decodedTrack.title} ${decodedTrack.author}`
      )

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)
      if (!bestMatch) {
        return { exception: { message: 'No suitable alternative found.', severity: 'fault' } }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    }

    const streamUrl = sourceData._resolvedUrl
    const format = this._guessFormat(streamUrl)
    const isDev = tryDev && !!devBase

    const additionalData = {
      isDev,
      userAgent,
      origin: this._getOrigin(isDev),
      referer: this._getLinkBase(isDev)
    }

    if (this._streamParamName) {
      additionalData.streamParam = this._extractQueryParam(streamUrl, this._streamParamName) || ''
    }

    return {
      url: streamUrl,
      protocol: 'https',
      format,
      additionalData
    }
  }

  async loadStream(decodedTrack, url, _protocol, additionalData) {
    try {
      const headers = {
        'User-Agent': additionalData?.userAgent || this.sourceConfig.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }

      if (additionalData?.origin) headers['Origin'] = additionalData.origin
      if (additionalData?.referer) headers['Referer'] = additionalData.referer
      if (this._streamParamName && additionalData?.streamParam) headers['Cookie'] = `${this._streamParamName}=${additionalData.streamParam}`

      const res = await http1makeRequest(url, {
        method: 'GET',
        headers,
        streamOnly: true
      })

      if (res.error || !res.stream) {
        throw res.error || new Error('Failed to get stream')
      }

      const out = new PassThrough()
      const src = res.stream

      src.pipe(out)
      src.once('error', (err) => out.destroy(err))
      out.once('close', () => src.destroy())
      out.once('error', () => src.destroy())
      out.once('end', () => out.emit('finishBuffering'))

      const format = additionalData?.format || this._guessFormat(url)
      const streamType = this._formatToMime(format)

      return { stream: out, type: streamType }
    } catch (err) {
      return { exception: { message: err.message, severity: 'common' } }
    }
  }

  _guessFormat(url) {
    try {
      const pathname = new URL(url).pathname
      const lastDot = pathname.lastIndexOf('.')
      if (lastDot !== -1 && lastDot < pathname.length - 1) {
        const ext = pathname.substring(lastDot + 1).toLowerCase()
        if (['aac', 'opus', 'ogg', 'mp3', 'mp4', 'm4a', 'flac', 'wav', 'webm'].includes(ext)) {
          return ext
        }
      }
    } catch {}
    return 'aac'
  }

  _formatToMime(format) {
    switch (format) {
      case 'aac': case 'm4a': case 'mp4': return 'audio/aac'
      case 'opus': case 'ogg': return 'audio/ogg'
      case 'mp3': return 'audio/mpeg'
      case 'flac': return 'audio/flac'
      case 'wav': return 'audio/wav'
      case 'webm': return 'video/webm'
      default: return 'audio/aac'
    }
  }

  _extractQueryParam(url, param) {
    try {
      return new URL(url).searchParams.get(param) || ''
    } catch {
      return ''
    }
  }
}
