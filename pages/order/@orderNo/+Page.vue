<template>
  <div v-if="!order" class="alert alert-warning">订单不存在，或查询凭证无效。</div>
  <div v-else class="space-y-6">
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body">
        <div class="flex items-start justify-between gap-4 max-md:flex-col">
          <div>
            <p class="text-sm uppercase tracking-[0.2em] text-primary">Order</p>
            <h1 class="text-2xl font-bold">{{ order.orderNo }}</h1>
          </div>
          <div class="flex gap-2">
            <StatusTag :type="getOrderStatusType(order.status)">{{ getOrderStatusLabel(order.status) }}</StatusTag>
            <StatusTag :type="getPaymentStatusType(order.paymentStatus)">{{ getPaymentStatusLabel(order.paymentStatus) }}</StatusTag>
            <StatusTag :type="getDeliveryStatusType(order.deliveryStatus)">{{ getDeliveryStatusLabel(order.deliveryStatus) }}</StatusTag>
          </div>
        </div>
      </div>
    </section>

    <section class="grid gap-6 lg:grid-cols-2">
      <article class="card bg-base-100 shadow-sm">
        <div class="card-body">
          <h2 class="card-title">订单信息</h2>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between"><span>商品</span><span>{{ order.productName }}</span></div>
            <div class="flex justify-between"><span>数量</span><span>{{ order.quantity }}</span></div>
            <div class="flex justify-between"><span>商品总价</span><span>{{ formatCents(order.originalAmount || order.amount) }}</span></div>
            <div v-if="order.discountCodeStr" class="flex justify-between text-orange-400">
              <span>折扣码</span>
              <span>{{ order.discountCodeStr }}</span>
            </div>
            <div v-if="order.discountAmount" class="flex justify-between text-orange-400">
              <span>折扣优惠</span>
              <span>-{{ formatCents(order.discountAmount) }}</span>
            </div>
            <div class="flex justify-between font-bold">
              <span>实付金额</span>
              <span class="text-primary">{{ formatCents(order.amount) }}</span>
            </div>
            <div class="flex justify-between"><span>支付方式</span><span>{{ getPaymentProviderLabel(order.paymentProvider) }}</span></div>
          </div>
          <div v-if="order.paymentStatus === 'UNPAID'" class="mt-4">
            <AppButton v-if="order.paymentProvider !== 'ALIPAY_FACE'" size="sm" variant="primary" :loading="paying" @click="handleContinuePay">继续支付</AppButton>
            <div v-if="order.paymentProvider === 'ALIPAY_FACE'" class="space-y-3">
              <div v-if="qrCodeUrl">
                <p class="text-sm text-base-content/70">请使用支付宝扫描下方二维码完成支付：</p>
                <div class="flex justify-center my-3">
                  <img :src="qrCodeUrl" alt="支付宝当面付二维码" class="w-48 h-48 rounded-box border border-base-300" />
                </div>
                <p class="text-xs text-center" :class="qrExpired ? 'text-error' : 'text-base-content/50'">
                  {{ qrExpired ? '二维码已过期' : `二维码有效期：${qrCountdown}` }}
                </p>
              </div>
              <div v-if="paying && !qrCodeUrl" class="flex justify-center py-8">
                <span class="loading loading-spinner loading-lg"></span>
              </div>
              <AppButton size="sm" variant="outline" :loading="paying" @click="handleRefreshQrCode">
                {{ qrExpired ? '重新生成二维码' : '刷新二维码' }}
              </AppButton>
            </div>
            <p v-if="paymentError" class="mt-2 text-sm text-error">{{ paymentError }}</p>
          </div>
        </div>
      </article>

      <article class="card bg-base-100 shadow-sm">
        <div class="card-body">
          <h2 class="card-title">发货内容</h2>
          <div v-if="order.deliveryContents.length" class="space-y-2">
            <pre v-for="content in order.deliveryContents" :key="content" class="rounded-box bg-base-200 p-3 text-sm">{{ content }}</pre>
          </div>
          <p v-else class="text-sm text-base-content/60">当前订单尚未支付或尚未自动发货。</p>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { normalizeTelefuncError } from "../../../lib/app-error";
import { ref, onMounted, onUnmounted } from "vue";
import AppButton from "../../../components/AppButton.vue";
import { useData } from "vike-vue/useData";
import { formatCents } from "../../../lib/utils/money";
import { getDeliveryStatusLabel, getDeliveryStatusType, getOrderStatusLabel, getOrderStatusType, getPaymentProviderLabel, getPaymentStatusLabel, getPaymentStatusType } from "../../../lib/utils/order-status";
import { updateLocalOrder } from "../../../lib/local-orders";
import StatusTag from "../../../components/StatusTag.vue";
import { onCreatePayment } from "./createPayment.telefunc";
import { onQueryAlipayPayment } from "./queryAlipayPayment.telefunc";
import type { Data } from "./+data";

const { order } = useData<Data>();
const paying = ref(false);
const paymentError = ref("");
const qrCodeUrl = ref("");
const qrCountdown = ref("");
const qrExpired = ref(false);

const QR_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 hours
const POLL_INTERVAL = 5000; // 5 seconds

let qrGeneratedAt = 0;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startCountdown() {
  stopCountdown();
  qrExpired.value = false;
  qrGeneratedAt = Date.now();

  countdownTimer = setInterval(() => {
    const remaining = QR_EXPIRE_MS - (Date.now() - qrGeneratedAt);
    if (remaining <= 0) {
      qrExpired.value = true;
      qrCountdown.value = "00:00";
      stopCountdown();
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    qrCountdown.value = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!order || order.paymentStatus !== "UNPAID") return;
    try {
      const result = await onQueryAlipayPayment({ orderNo: order.orderNo });
      if (result.isPaid || result.alreadyPaid) {
        window.location.reload();
      }
    } catch {}
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
  if (!order) return;

  updateLocalOrder({
    orderNo: order.orderNo,
    queryToken: order.queryToken,
    productName: order.productName,
    amount: order.amount,
    createdAt: order.createdAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    deliveryStatus: order.deliveryStatus,
  });

  if (order.paymentStatus === 'UNPAID' && order.paymentProvider === 'ALIPAY_FACE') {
    await generateQrCode();
    startPolling();
    return;
  }

  if (order.paymentStatus !== "UNPAID" || order.paymentProvider !== "ALIPAY") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.get("out_trade_no")) return;
  try {
    const result = await onQueryAlipayPayment({ orderNo: order.orderNo });
    if (result.isPaid || result.alreadyPaid) window.location.reload();
  } catch {}
});

onUnmounted(() => {
  stopCountdown();
  stopPolling();
});

async function generateQrCode() {
  if (!order) return;

  paying.value = true;
  paymentError.value = "";

  try {
    const result = await onCreatePayment({ orderId: order.id });
    if (result.payUrl) {
      const text = encodeURIComponent(result.payUrl);
      qrCodeUrl.value = `https://quickchart.io/qr?text=${text}&size=300&ecLevel=M`;
      startCountdown();
      return;
    }
    paymentError.value = "未获取到支付二维码";
  } catch (error) {
    paymentError.value = normalizeTelefuncError(error, "生成二维码失败");
  } finally {
    paying.value = false;
  }
}

async function handleRefreshQrCode() {
  await generateQrCode();
}

async function handleContinuePay() {
  if (!order) return;

  paying.value = true;
  paymentError.value = "";

  try {
    const result = await onCreatePayment({ orderId: order.id });
    if (result.payUrl) {
      window.location.href = result.payUrl;
      return;
    }
    paymentError.value = "未获取到支付链接";
  } catch (error) {
    paymentError.value = normalizeTelefuncError(error, "拉起支付失败");
  } finally {
    paying.value = false;
  }
}
</script>
