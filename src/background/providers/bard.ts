import ExpiryMap from 'expiry-map'
import { ofetch } from 'ofetch'

import { GenerateAnswerParams, Provider } from '../types'

async function request(token: string, method: string, path: string, data?: unknown) {
  return fetch(`https://chat.openai.com/backend-api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
}

export async function sendMessageFeedback(token: string, data: unknown) {
  await request(token, 'POST', '/conversation/message_feedback', data)
}

export async function setConversationProperty(
  token: string,
  conversationId: string,
  propertyObject: object,
) {
  await request(token, 'PATCH', `/conversation/${conversationId}`, propertyObject)
}

const KEY_ACCESS_TOKEN = 'accessToken'

const cache = new ExpiryMap(10 * 1000)

export async function getBardAccessToken(): Promise<string> {
  if (cache.get(KEY_ACCESS_TOKEN)) {
    return cache.get(KEY_ACCESS_TOKEN)
  }
  const resp = await fetch('https://chat.openai.com/api/auth/session')
  if (resp.status === 403) {
    throw new Error('CLOUDFLARE')
  }
  const data = await resp.json().catch(() => ({}))
  if (!data.accessToken) {
    throw new Error('UNAUTHORIZED')
  }
  cache.set(KEY_ACCESS_TOKEN, data.accessToken)
  return data.accessToken
}

export class BARDProvider implements Provider {
  constructor(private token: string) {
    this.token = token
  }

  private extractFromHTML(variableName: string, html: string) {
    const regex = new RegExp(`"${variableName}":"([^"]+)"`)
    const match = regex.exec(html)
    return match?.[1]
  }

  private async fetchRequestParams() {
    const html = await ofetch('https://bard.google.com/faq')
    const atValue = this.extractFromHTML('SNlM0e', html)
    const blValue = this.extractFromHTML('cfb2h', html)
    return { atValue, blValue }
  }

  private async parseBartResponse(resp: string) {
    const data = JSON.parse(resp.split('\n')[3])
    const payload = JSON.parse(data[0][2])
    if (!payload) {
      throw new ChatError('Failed to access Bard', ErrorCode.BARD_EMPTY_RESPONSE)
    }
    const text = payload[0][0]
    return {
      text,
      ids: [...payload[1], payload[4][0][0]] as [string, string, string],
    }
  }

  private async generateReqId() {
    return Math.floor(Math.random() * 900000) + 100000
  }

  async generateAnswer(params: GenerateAnswerParams) {
    let conversationId: string | undefined
    const cleanup = () => {
      if (conversationId) {
        setConversationProperty(this.token, conversationId, { is_visible: false })
      }
    }

    if (!this.conversationContext) {
      this.conversationContext = {
        requestParams: await this.fetchRequestParams(),
        contextIds: ['', '', ''],
      }
    }
    const { requestParams, contextIds } = this.conversationContext
    const resp = await ofetch(
      'https://bard.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      {
        method: 'POST',
        signal: params.signal,
        query: {
          bl: requestParams.blValue,
          _reqid: this.generateReqId(),
          rt: 'c',
        },
        body: new URLSearchParams({
          at: requestParams.atValue!,
          'f.req': JSON.stringify([
            null,
            `[[${JSON.stringify(params.prompt)}],null,${JSON.stringify(contextIds)}]`,
          ]),
        }),
        parseResponse: (txt) => txt,
      },
    )
    const { text, ids } = await this.parseBartResponse(resp)
    console.debug('text:', text)
    console.debug('ids:', ids)
    this.conversationContext.contextIds = ids

    if (text) {
      conversationId = 'dataconversation_id'
      params.onEvent({
        type: 'answer',
        data: {
          text,
          messageId: 'datamessage.id',
          conversationId: 'dataconversation_id',
          parentMessageId: 'dataparent_message_id',
        },
      })
    }

    params.onEvent({ type: 'DONE' })
    cleanup()
    return { cleanup }
  }

  resetConversation() {
    this.conversationContext = undefined
  }
}
