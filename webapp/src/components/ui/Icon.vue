<script setup>
// Lucide SVG-иконки. В WebApp эмодзи не используются.
import {
  LayoutDashboard, Megaphone, FlaskConical, Wrench, Settings, ShieldAlert, Search, Globe,
  Calculator, Filter, FileText, Wallet, Plug, Sparkles, Trash2, Plus, RefreshCw, Pause, Play,
  TrendingUp, TrendingDown, Check, X, ChevronRight, ArrowLeft, AlertTriangle, Info, CircleCheck,
  CircleX, Bot, Eye, Target, Zap, Shield, Users, QrCode, Copy, Save, Key, Activity, BarChart3,
  Link, Clock, Pencil, ArrowUpRight, Gauge, Layers, MousePointerClick, CircleDollarSign,
  Percent, Hash,
} from 'lucide-vue-next'
import { computed } from 'vue'

const MAP = {
  dashboard: LayoutDashboard, megaphone: Megaphone, flask: FlaskConical, wrench: Wrench,
  settings: Settings, shield: ShieldAlert, search: Search, globe: Globe, calculator: Calculator,
  filter: Filter, file: FileText, wallet: Wallet, plug: Plug, sparkles: Sparkles, trash: Trash2,
  plus: Plus, refresh: RefreshCw, pause: Pause, play: Play, up: TrendingUp, down: TrendingDown,
  check: Check, x: X, chevron: ChevronRight, back: ArrowLeft, alert: AlertTriangle, info: Info,
  ok: CircleCheck, fail: CircleX, bot: Bot, eye: Eye, target: Target, zap: Zap, shieldCheck: Shield,
  users: Users, qr: QrCode, copy: Copy, save: Save, key: Key, activity: Activity, chart: BarChart3,
  link: Link, clock: Clock, pencil: Pencil, arrowUp: ArrowUpRight, gauge: Gauge, layers: Layers,
  click: MousePointerClick, money: CircleDollarSign, percent: Percent, hash: Hash,
}

const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 18 },
  stroke: { type: Number, default: 2 },
})

const component = computed(() => MAP[props.name] || Info)
</script>

<template>
  <component :is="component" :size="size" :stroke-width="stroke" aria-hidden="true" class="icon" />
</template>

<style scoped>
.icon { flex: 0 0 auto; }
</style>
