// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}


export interface SendReceipt {
    fingerprint: string;
    startedAt: number;
    rejected?: boolean;
    providerId?: string;
    messageId?: string;
}

export class EmailSendError extends Error {
    constructor(message: string, public status = 502) { super(message); }
}

export function emailSendFailure(error: unknown): Response {
    const known = error instanceof EmailSendError;
    return Response.json({ error: known ? error.message : "Could not save this send. If it was accepted, retry the same unchanged message to recover it." },
        { status: known ? error.status : 502 });
}

const SUPPORT = "support@reflowreader.com";
const API = "https://api.resend.com";
const MAX_RETRY_AGE = 24 * 60 * 60 * 1000;

function address(value: SendEmailParams["from"]): string {
    if (typeof value !== "string") return value.email.toLowerCase();
    return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
}

async function digest(value: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
        .map((n) => n.toString(16).padStart(2, "0")).join("");
}

async function request(key: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${API}${path}`, { ...init,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(10000) });
}

/** Resend is used only for the requested support mailbox. Other mailboxes retain their existing transport. */
export async function sendEmail(env: Env, params: SendEmailParams, operationId: string = crypto.randomUUID()): Promise<{ messageId: string }> {
    if (address(params.from) !== SUPPORT) {
        const result = await env.EMAIL.send(params as any);
        return { messageId: result.messageId.replace(/^<|>$/g, "") };
    }
    if (!env.RESEND_API_KEY) throw new EmailSendError("Support sending is not configured. Add the Resend secret and verify reflowreader.com.", 503);
    if (!/^(?:sent-)?[a-f0-9-]{36}$/i.test(operationId)) throw new EmailSendError("Invalid send operation ID.", 400);

    // A sending-only key cannot read the RFC Message-ID. Fail before sending if read access is absent.
    try {
        const preflight = await request(env.RESEND_READ_API_KEY || env.RESEND_API_KEY, "/emails?limit=1");
        if (!preflight.ok) throw new EmailSendError("Configure Resend message read access before sending, so replies can stay in the correct thread.", 503);
    } catch (error) {
        if (error instanceof EmailSendError) throw error;
        throw new EmailSendError("Could not verify Resend access. No email was sent; try again.", 503);
    }

    const payload = {
        from: `ReflowPDF Support <${SUPPORT}>`, to: params.to,
        subject: params.subject, html: params.html, text: params.text,
        cc: params.cc, bcc: params.bcc, reply_to: SUPPORT, headers: params.headers,
        attachments: params.attachments?.map((att) => ({
            content: att.content, filename: att.filename, content_type: att.type,
            ...(att.disposition === "inline" && att.contentId ? { content_id: att.contentId } : {}),
        })),
    };
    const body = JSON.stringify(payload);
    const fingerprint = await digest(body);
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(SUPPORT));
    let receipt = await stub.prepareSendReceipt(operationId, fingerprint) as SendReceipt;
    if (!receipt.providerId) {
        if (Date.now() - receipt.startedAt >= MAX_RETRY_AGE) {
            throw new EmailSendError("This send is too old to retry safely. Check Resend delivery history before creating a new message.", 409);
        }
        let response: Response;
        try {
            response = await request(env.RESEND_API_KEY, "/emails", { method: "POST", body,
                headers: { "Idempotency-Key": `support-${operationId}-${fingerprint.slice(0, 32)}` } });
        } catch {
            throw new EmailSendError("The send result is uncertain. Keep this message unchanged and retry it; do not create another copy.");
        }
        if (!response.ok) {
            const code = response.status;
            const reason = code === 429 ? "Resend rate or quota limit reached." :
                code === 401 || code === 403 ? "Resend API access is not authorized." :
                code === 422 ? "Resend rejected the message. Check domain verification, recipients and attachments." :
                code === 409 ? "This send ID already belongs to another message." : "Resend did not accept this request.";
            if (code < 500) await stub.recordSendReceipt(operationId, { ...receipt, rejected: true });
            throw new EmailSendError(reason, code === 429 ? 429 : code === 409 ? 409 : 502);
        }
        const result = await response.json() as { id?: string };
        if (!result.id) throw new EmailSendError("The send result is uncertain. Retry this unchanged message to recover it.");
        receipt = { ...receipt, rejected: false, providerId: result.id };
        // Save provider acceptance BEFORE any subsequent network or local sent-folder write.
        await stub.recordSendReceipt(operationId, receipt);
    }
    if (!receipt.messageId) {
        try {
            let messageId: string | undefined;
            // Resend may return 200 with a null RFC ID while a newly accepted email is queued.
            // Retry only this read: provider acceptance is already durable and must never be POSTed again.
            for (let attempt = 0; attempt < 5; attempt++) {
                const response = await request(env.RESEND_READ_API_KEY || env.RESEND_API_KEY, `/emails/${encodeURIComponent(receipt.providerId!)}`);
                if (!response.ok) throw new Error("Readback failed");
                const result = await response.json() as { message_id?: string | null };
                if (result.message_id) {
                    if (!/^<[^<>\s]+@[^<>\s]+>$/.test(result.message_id)) throw new Error("Invalid RFC Message-ID");
                    messageId = result.message_id.slice(1, -1);
                    break;
                }
                if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
            }
            if (!messageId) throw new Error("Message ID unavailable");
            receipt = { ...receipt, messageId };
            await stub.recordSendReceipt(operationId, receipt);
        } catch {
            throw new EmailSendError("Resend accepted this message, but its thread ID could not be confirmed. Retry this unchanged message to recover it; it will not be sent again.");
        }
    }
    return { messageId: receipt.messageId! };
}
