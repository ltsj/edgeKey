import { badRequestError } from "../../lib/app-error";
import type { PaymentProviderAdapter } from "./provider";

export interface AlipayFaceConfig {
  baseUrl?: string;
  alipayAppId?: string;
  alipayPrivateKey?: string;
  alipayPublicKey?: string;
}

function pemToBase64(pem: string) {
  return pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
}

async function rsaSign(content: string, privateKeyBase64: string): Promise<string> {
  const keyData = Uint8Array.from(atob(pemToBase64(privateKeyBase64)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(content));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function rsaVerify(content: string, signBase64: string, publicKeyBase64: string): Promise<boolean> {
  try {
    const keyData = Uint8Array.from(atob(pemToBase64(publicKeyBase64)), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "spki",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const encoder = new TextEncoder();
    const sigData = Uint8Array.from(atob(signBase64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigData, encoder.encode(content));
  } catch {
    return false;
  }
}

function buildSignString(params: Record<string, string>) {
  return Object.entries(params)
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function createAlipayFaceAdapter(config: AlipayFaceConfig): PaymentProviderAdapter {
  return {
    async createPayment(input) {
      const gateway = `${config.baseUrl?.trim().replace(/\/+$/, "")}/gateway.do`;

      if (!config.alipayAppId || !config.alipayPrivateKey) {
        throw badRequestError("支付宝当面付配置不完整", "ALIPAY_FACE_CONFIG_INCOMPLETE");
      }

      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

      const bizContent = JSON.stringify({
        out_trade_no: input.orderNo,
        total_amount: (input.amount / 100).toFixed(2),
        subject: input.productName,
        product_code: "QR_CODE_OFFLINE",
      });

      const params: Record<string, string> = {};
      params.app_id = config.alipayAppId;
      params.method = "alipay.trade.precreate";
      params.charset = "utf-8";
      params.sign_type = "RSA2";
      params.timestamp = timestamp;
      params.version = "1.0";
      if (input.notifyUrl) params.notify_url = input.notifyUrl;
      params.biz_content = bizContent;

      const signStr = buildSignString(params);
      const sign = await rsaSign(signStr, config.alipayPrivateKey);

      const query = new URLSearchParams({ ...params, sign }).toString();
      const response = await fetch(`${gateway}?${query}`);
      const json = await response.json() as {
        alipay_trade_precreate_response?: {
          code?: string;
          msg?: string;
          qr_code?: string;
          out_trade_no?: string;
        };
        sign?: string;
      };

      const res = json.alipay_trade_precreate_response;
      if (!res || res.code !== "10000") {
        throw badRequestError(
          `支付宝当面付下单失败: ${res?.msg || res?.code || "未知错误"}`,
          "ALIPAY_FACE_PRECREATE_FAILED",
        );
      }

      if (!res.qr_code) {
        throw badRequestError("支付宝未返回二维码", "ALIPAY_FACE_NO_QR_CODE");
      }

      return {
        payUrl: res.qr_code,
        paymentOrderNo: input.orderNo,
        raw: json,
      };
    },

    async verifyNotify(payload) {
      if (!config.alipayPublicKey) {
        return { isValid: false, raw: payload, message: "missing alipay public key" };
      }

      const sign = payload.sign ?? "";
      const unsigned = { ...payload };
      delete unsigned.sign;
      delete unsigned.sign_type;

      const signStr = buildSignString(unsigned);
      const isValid = await rsaVerify(signStr, sign, config.alipayPublicKey);
      const tradeStatus = payload.trade_status ?? "";
      const isPaid = tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED";

      return {
        isValid,
        orderNo: payload.out_trade_no,
        paymentOrderNo: payload.trade_no,
        amount: payload.total_amount ? Math.round(Number(payload.total_amount) * 100) : undefined,
        status: isPaid ? "PAID" : tradeStatus ? "FAILED" : "PENDING",
        raw: payload,
        message: isValid ? "ok" : "invalid signature",
      };
    },
  };
}
