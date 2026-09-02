/**
 * analyze_image — ask a vision model about a local image file.
 *
 * The CLI owns local filesystem access, so this tool reads the image bytes and
 * sends the same bounded attachment shape used by the preflight vision path to
 * the authenticated backend `/api/vision/analyze` endpoint.
 */
import { BahulamAuth } from '../auth/bahulam-auth.mjs';
import {
  loadImageAttachment,
  publicAttachmentMetadata,
} from '../core/attachments.mjs';

function visionFailureMessage(message, attachment) {
  const base = String(message || 'Vision analysis failed').trim().replace(/[.。]+$/g, '');
  const lower = base.toLowerCase();
  const guidance = `File was loaded as ${attachment?.mime_type || 'an image'}; do not retry this image with read_attachment.`;
  if (lower.includes('empty analysis') || lower.includes('no text answer') || lower.includes('no visible text answer') || lower.includes('finish_reason=length')) {
    return `${base}. ${guidance} The provider call completed but did not return visible answer text; retry analyze_image with a more specific question or switch the configured vision model.`;
  }
  return `${base}. ${guidance}`;
}

export const AnalyzeImageTool = {
  name: 'analyze_image',
  description:
    'Answer a specific question about a local image file. Pass path=<local image path> and question=<what to inspect>. Use for screenshots, diagrams, photos, and UI images.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Local image file path. JPEG, PNG, WebP, and GIF are supported.',
      },
      file_path: {
        type: 'string',
        description: 'Alias for path.',
      },
      upload_id: {
        type: 'string',
        description: 'Chat-only image upload id. Not supported in the CLI; use path instead.',
      },
      question: {
        type: 'string',
        description: 'Specific question to ask about the image. Example: "Describe the UI layout and visible errors."',
      },
    },
    required: ['question'],
  },

  validateInput(input) {
    const errors = [];
    const pathValue = String(input?.path || input?.file_path || '').trim();
    const uploadId = String(input?.upload_id || '').trim();
    if (!pathValue && !uploadId) errors.push('path is required');
    if (!String(input?.question || '').trim()) errors.push('question is required');
    return errors;
  },

  async call(input) {
    const uploadId = String(input?.upload_id || '').trim();
    const rawPath = String(input?.path || input?.file_path || '').trim();
    const question = String(input?.question || '').trim() || 'Describe this image in detail.';

    if (uploadId && !rawPath) {
      return {
        success: false,
        output: 'upload_id is a chat-only mode. In the CLI, pass path=<local image path>.',
        _tool: 'analyze_image',
      };
    }
    if (!rawPath) {
      return {
        success: false,
        output: 'analyze_image requires path=<local image path>.',
        _tool: 'analyze_image',
      };
    }

    let attachment;
    try {
      attachment = loadImageAttachment(rawPath, { cwd: process.cwd() });
    } catch (err) {
      return {
        success: false,
        output: `Failed to load image: ${err.message || err}`,
        _tool: 'analyze_image',
      };
    }

    const creds = new BahulamAuth().loadCredentials();
    if (!creds.backendUrl || !creds.token) {
      return {
        success: false,
        output: 'analyze_image requires CLI auth. Run `bahulam-code login` or set B0_TOKEN.',
        _tool: 'analyze_image',
      };
    }

    let response;
    try {
      response = await fetch(`${creds.backendUrl}/api/vision/analyze`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
          'X-Product': process.env.BAHULAM_PRODUCT || 'bahulam',
        },
        body: JSON.stringify({
          instruction: question,
          attachments: [attachment],
        }),
      });
    } catch (err) {
      return {
        success: false,
        output: `Vision analysis unreachable: ${err.message || err}`,
        _tool: 'analyze_image',
      };
    }

    const text = await response.text().catch(() => '');
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { detail: text };
    }

    if (!response.ok) {
      const detail = payload?.detail || payload || {};
      const message = typeof detail === 'string'
        ? detail
        : detail.message || detail.error || `Vision analysis failed (${response.status})`;
      return {
        success: false,
        output: visionFailureMessage(message, attachment),
        status: response.status,
        detail,
        _tool: 'analyze_image',
      };
    }

    const summary = String(payload?.summary || '').trim();
    return {
      success: true,
      output: summary || '(no vision summary returned)',
      summary,
      model: payload?.model || '',
      provider: payload?.provider || 'backend-vision',
      attachments: Array.isArray(payload?.attachments)
        ? payload.attachments
        : [publicAttachmentMetadata(attachment)],
      usage: payload?.usage || {},
      _tool: 'analyze_image',
    };
  },
};
