import { NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth/server-session'
import { asUser } from '@/server/db'
import { getWhatsAppSendConfig } from '@/server/repos/messages'
import { getProfileByUserId } from '@/server/repos/profiles'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const session = await getServerSession()
    if (!session) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }
    const userId = session.user.id

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { accountId, config } = await asUser(userId, async (db) => {
      const profile = await getProfileByUserId(db, userId)
      const accountId = profile?.account_id ?? undefined
      if (!accountId) return { accountId: undefined, config: undefined }
      return { accountId, config: await getWhatsAppSendConfig(db, accountId) }
    })
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    if (!config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
