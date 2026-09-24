export interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes: Array<{
      value: WhatsAppChangeValue;
      field: string;
    }>;
  }>;
}

export interface WhatsAppChangeValue {
  messaging_product: string;
  metadata: {
    display_phone_number?: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    profile?: {
      name: string;
    };
    wa_id: string;
  }>;
  messages?: Array<WhatsAppRawMessage>;
  statuses?: Array<WhatsAppRawStatus>;
}

export interface WhatsAppRawMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: {
    body: string;
  };
  image?: {
    id: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
  audio?: {
    id: string;
    mime_type?: string;
  };
  document?: {
    id: string;
    filename?: string;
    mime_type?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  interactive?: {
    type: 'button_reply' | 'list_reply' | string;
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
  };
  referral?: {
    source_url?: string;
    source_type?: string;
    source_id?: string;
    headline?: string;
    body?: string;
    media_type?: string;
    image_url?: string;
    video_url?: string;
  };
  [key: string]: unknown;
}

export interface WhatsAppRawStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    origin?: {
      type: string;
    };
  };
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string;
  };
  errors?: Array<{
    code: number;
    title: string;
    message?: string;
    error_data?: {
      details: string;
    };
  }>;
  biz_opaque_callback_data?: string;
}

export interface NormalizedInteractive {
  type: 'button_reply' | 'list_reply' | string;
  id: string;
  title: string;
  description?: string;
}

export interface NormalizedReferral {
  sourceUrl?: string;
  sourceType?: string;
  sourceId?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface NormalizedInboundMessage {
  externalMessageId: string;
  fromPhone: string;
  messageType: string;
  content: string | null;
  timestamp: string;
  interactive?: NormalizedInteractive;
  referral?: NormalizedReferral;
  rawPayload: Record<string, unknown>;
}

export interface WhatsAppSendResponse {
  messaging_product: string;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
  }>;
}

export type SendResultErrorType =
  | 'EXPLICIT_RETRYABLE'
  | 'EXPLICIT_FATAL'
  | 'UNCERTAIN_TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'CONFIG_ERROR';

export type WhatsAppSendAttemptStatus =
  'INITIATED' | 'ACCEPTED' | 'RETRYABLE_REJECTION' | 'FATAL_FAILURE' | 'UNCERTAIN';

export interface SendResult {
  success: boolean;
  messageId?: string;
  errorType?: SendResultErrorType;
  error?: string;
  rawResponse?: unknown;
}

export type InboundMessageStatus =
  | 'RECEIVED'
  | 'CLAIMED'
  | 'SENDING'
  | 'PROCESSED'
  | 'RETRY_PENDING'
  | 'FAILED_FINAL'
  | 'UNCERTAIN'
  | 'IGNORED';

export interface WebhookProcessingResult {
  processed: number;
  duplicates: number;
  ignored: number;
  errors: number;
  details: Array<{
    externalMessageId?: string;
    status:
      | 'PROCESSED'
      | 'DUPLICATE'
      | 'IGNORED'
      | 'FAILED'
      | 'UNCERTAIN'
      | 'RETRY_PENDING'
      | 'FAILED_FINAL';
    error?: string;
  }>;
}
