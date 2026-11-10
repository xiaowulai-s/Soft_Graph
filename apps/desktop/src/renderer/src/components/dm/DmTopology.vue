<script setup lang="ts">
/**
 * DmTopology —— DiskMirror「同步拓扑」d3-force 图（视觉与尺寸 1:1）。
 * v6.2.3 加入同步演出：连线 dash 流光（两档都有）、抽象粒子飞行（仅 vivid）、
 * 节点呼吸光晕、完成时连线收束与节点亮起；粒子层不与真实文件一一对应。
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation
} from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import type { BackupDriveInfo, BackupTask } from '@shared/types'
import DmFlowLayer from './DmFlowLayer.vue'
import { dmDrives, dmRunStates, dmTasks, taskTarget } from './dmState'
import { isVivid } from './dmMotion'

const props = defineProps<{ tasks?: BackupTask[]; drives?: BackupDriveInfo[] }>()

interface FlowLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  active: boolean
}

interface Node extends SimulationNodeDatum {
  id: string
  label: string
  kind: 'pc' | 'src' | 'disk'
}
interface Link extends SimulationLinkDatum<Node> {
  source: string | Node
  target: string | Node
  active: boolean
}

const nodes = shallowRef<Node[]>([])
const links = shallowRef<Link[]>([])
let sim: Simulation<Node, Link> | null = null
let rawNodes: Node[] = []

const running = computed(() =>
  Object.values(dmRunStates.value).some((s) => s.phase === 'running')
)
const finishing = ref(false)
let finishTimer: number | undefined
watch(running, (now, before) => {
  if (before && !now) {
    finishing.value = true
    if (finishTimer) window.clearTimeout(finishTimer)
    finishTimer = window.setTimeout(() => {
      finishing.value = false
    }, 1200)
  }
})

const flowLinks = computed<FlowLink[]>(() =>
  links.value.map((l, i) => ({
    key: String(i),
    x1: px(l.source),
    y1: py(l.source),
    x2: px(l.target),
    y2: py(l.target),
    active: l.active
  }))
)

function useTasks(): BackupTask[] {
  return props.tasks ?? dmTasks.value
}
function useDrives(): BackupDriveInfo[] {
  return props.drives ?? dmDrives.value
}

function signature(): string {
  return `${useTasks()
    .map((t) => `${t.id}:${taskTarget(t)}`)
    .join('|')}#${useDrives()
    .map((d) => d.letter)
    .join('|')}`
}

/** 从显式映射目标路径 / 镜像模式盘符 / 卷标，反查当前接入的磁盘 */
function driveFor(task: BackupTask): BackupDriveInfo | undefined {
  const drives = useDrives()
  const target = taskTarget(task)
  const m = target.match(/^([A-Za-z]):/)
  if (m) {
    const hit = drives.find((d) => d.letter.replace(/:$/, '').toUpperCase() === m[1].toUpperCase())
    if (hit) return hit
  }
  if (task.driveLetter) {
    const hit = drives.find(
      (d) => d.letter.replace(/:$/, '').toUpperCase() === task.driveLetter!.replace(/:$/, '').toUpperCase()
    )
    if (hit) return hit
  }
  if (task.volumeLabel) {
    const hit = drives.find((d) => d.label && d.label.trim() === task.volumeLabel.trim())
    if (hit) return hit
  }
  return undefined
}

function rebuild(): void {
  sim?.stop()
  const tasks = useTasks()
  const drives = useDrives()
  const ns: Node[] = [{ id: 'pc', label: '本机', kind: 'pc' }]
  const ls: Link[] = []
  const diskAdded = new Set<string>()
  for (const task of tasks) {
    const srcId = `src:${task.id}`
    ns.push({ id: srcId, label: task.name, kind: 'src' })
    ls.push({ source: 'pc', target: srcId, active: true })
    const drive = driveFor(task)
    if (drive) {
      const diskId = `disk:${drive.letter}`
      if (!diskAdded.has(diskId)) {
        diskAdded.add(diskId)
        ns.push({
          id: diskId,
          label: `${drive.letter} ${(drive.label || '移动硬盘').slice(0, 12)}`,
          kind: 'disk'
        })
      }
      const phase = dmRunStates.value[task.id]?.phase
      ls.push({ source: srcId, target: diskId, active: !phase || phase === 'running' || phase === 'done' })
    }
  }
  rawNodes = ns
  nodes.value = [...ns]
  links.value = [...ls]
  if (ns.length < 2) return
  sim = forceSimulation<Node>(ns)
    .force('link', forceLink<Node, Link>(ls).id((d) => d.id).distance(115).strength(0.55))
    .force('charge', forceManyBody().strength(-420))
    .force('center', forceCenter(300, 126))
    .force('collide', forceCollide(46))
    .stop()
  for (let i = 0; i < 160; i++) sim.tick()
  nodes.value = [...ns]
  links.value = [...ls]
}

function nodeOf(value: string | Node): Node | undefined {
  return typeof value === 'string' ? rawNodes.find((n) => n.id === value) : value
}
function px(value: string | Node): number {
  return nodeOf(value)?.x ?? 0
}
function py(value: string | Node): number {
  return nodeOf(value)?.y ?? 0
}

function nodeFill(node: Node): string {
  if (node.kind === 'pc') return '#0a3746'
  if (node.kind === 'disk') return '#0e7490'
  const id = node.id.slice(4)
  const phase = dmRunStates.value[id]?.phase
  if (phase === 'running') return '#06b6d4'
  if (phase === 'done') return '#0891b2'
  if (phase === 'error' || phase === 'paused') return '#d84a4a'
  return '#8aa4ae'
}
function nodeRadius(node: Node): number {
  return node.kind === 'pc' ? 26 : 21
}
function isRunningNode(node: Node): boolean {
  if (node.kind !== 'src') return false
  return dmRunStates.value[node.id.slice(4)]?.phase === 'running'
}

onMounted(rebuild)
onUnmounted(() => {
  sim?.stop()
  if (finishTimer) window.clearTimeout(finishTimer)
})
watch(signature, rebuild)
watch(() => Object.keys(dmRunStates.value).length, rebuild)
</script>

<template>
  <div>
    <svg
      class="dm-topology"
      :class="{
        'motion-vivid': isVivid,
        'motion-calm': !isVivid,
        'is-running': running,
        'is-finishing': finishing
      }"
      viewBox="0 0 600 268"
      role="img"
      aria-label="源文件夹与移动硬盘的同步拓扑"
    >
      <line
        v-for="(link, index) in links"
        :key="index"
        class="dm-flow-line"
        :class="{ active: link.active }"
        :x1="px(link.source)"
        :y1="py(link.source)"
        :x2="px(link.target)"
        :y2="py(link.target)"
        :stroke="link.active ? '#0891b2' : '#c9d9df'"
        :stroke-width="link.active ? 2 : 1.5"
        :stroke-dasharray="link.active ? '0' : '5 5'"
      />
      <DmFlowLayer :links="flowLinks" :running="running" :vivid="isVivid" />
      <g v-for="node in nodes" :key="node.id" :transform="`translate(${node.x ?? 0}, ${node.y ?? 0})`">
        <circle
          class="dm-node-glow"
          :class="{ 'is-hot': isRunningNode(node) }"
          :r="nodeRadius(node) + 6"
          :fill="nodeFill(node)"
          opacity="0.12"
        />
        <circle class="dm-node-core" :r="nodeRadius(node)" :fill="nodeFill(node)" />
        <circle v-if="node.kind !== 'pc'" :r="5" fill="#ffffff" opacity="0.9" />
        <text
          y="40"
          text-anchor="middle"
          font-size="11"
          fill="#4d6b78"
          font-family="Segoe UI, Microsoft YaHei, sans-serif"
        >
          {{ node.label }}
        </text>
      </g>
    </svg>
    <div class="dm-legend">
      <span><i style="background: #0a3746" />本机</span>
      <span><i style="background: #0891b2" />源文件夹</span>
      <span><i style="background: #0e7490" />移动硬盘</span>
      <span><i style="background: #c9d9df" />未就绪</span>
      <span v-if="running" class="dm-legend-live"><i class="dm-legend-pulse" />正在同步</span>
    </div>
  </div>
</template>
