import {
  addEdge, Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { useCallback, useEffect, useRef } from 'react';
import { useDialog } from './Overlay';
import type { Diagram, KeyName } from '../types';

type NodeData = { kind: string; kindName: string; label: string; readOnly?: boolean };
type DNode = Node<NodeData, 'component'>;

const ICONS: Record<string, string> = {
  client: '◉', mobile_app: '▯', web_app: '▭', dns: '⌘', cdn: '☁', waf: '⛨', load_balancer: '⇋', api_gateway: '⇥', auth: '⚿',
  rate_limiter: '⏱', service: '▣', worker: '⚙', scheduler: '⏲', queue: '☰', stream: '≋', pubsub: '⇶', cache: '⚡', database: '⛁',
  read_replica: '⛀', object_storage: '▤', search_index: '⌕', data_warehouse: '▦', lock_service: '⚷', config_store: '⚑',
  observability: '◔', external_api: '↗', llm: '✦', vector_store: '⋮', websocket_gateway: '⇄', note: '✎',
};

function ComponentNode({ id, data, selected }: NodeProps<DNode>) {
  const { updateNodeData } = useReactFlow<DNode>();
  return (
    <div className={clsx('dnode', selected && 'selected', data.kind === 'note' && 'note')}>
      {data.kind !== 'note' && (
        <>
          <Handle type="target" position={Position.Left} />
          <Handle type="source" position={Position.Right} />
          <Handle type="target" position={Position.Top} id="t" />
          <Handle type="source" position={Position.Bottom} id="b" />
        </>
      )}
      <span className="dnode-type">{ICONS[data.kind] ?? '▣'} {data.kindName}</span>
      {data.readOnly ? (
        <strong>{data.label}</strong>
      ) : (
        <input className="nodrag" value={data.label} aria-label={`${data.kindName} label`}
          onChange={(e) => updateNodeData(id, { label: e.target.value })} />
      )}
    </div>
  );
}

const nodeTypes = { component: ComponentNode };
const edgeDefaults = { markerEnd: { type: MarkerType.ArrowClosed, color: '#1b4f7f' }, type: 'smoothstep' as const };

interface Props {
  components: KeyName[];
  initial?: Diagram;
  onChange?: (d: Diagram) => void; // omitted = read-only
}

function toFlow(d: Diagram | undefined, components: KeyName[], readOnly: boolean): { nodes: DNode[]; edges: Edge[] } {
  const name = (k: string) => components.find((c) => c.key === k)?.name ?? k;
  return {
    nodes: (d?.nodes ?? []).map((n) => ({
      id: n.id, type: 'component', position: { x: n.x, y: n.y },
      data: { kind: n.type, kindName: name(n.type), label: n.label, readOnly },
    })),
    edges: (d?.edges ?? []).map((e) => ({ ...edgeDefaults, id: e.id, source: e.source, target: e.target, label: e.label || undefined })),
  };
}

function Editor({ components, initial, onChange }: Props) {
  const readOnly = !onChange;
  const start = useRef(toFlow(initial, components, readOnly));
  const [nodes, setNodes, onNodesChange] = useNodesState<DNode>(start.current.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(start.current.edges);
  const counter = useRef(start.current.nodes.length + 1);
  const { screenToFlowPosition } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);
  const { prompt } = useDialog();

  // Report the serialised diagram upward whenever the graph changes (the parent owns the draft).
  useEffect(() => {
    onChange?.({
      nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, label: n.data.label, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : '' })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const add = (c: KeyName) => {
    const id = `n${counter.current++}`;
    // Lay new components out on a grid from the visible top-left so they never stack on each other.
    const rect = canvas.current?.getBoundingClientRect();
    const origin = rect ? screenToFlowPosition({ x: rect.left + 24, y: rect.top + 24 }) : { x: 24, y: 24 };
    // Leave a clear lane between components so the connecting lines are visible and easy to grab.
    const COL = 250;
    const ROW = 130;
    const cols = rect ? Math.max(1, Math.floor((rect.width - 24) / COL)) : 3;
    const k = nodes.length;
    setNodes((ns) => [...ns, {
      id, type: 'component', position: { x: origin.x + (k % cols) * COL, y: origin.y + Math.floor(k / cols) * ROW },
      data: { kind: c.key, kindName: c.name, label: c.key === 'note' ? 'Note' : c.name },
    }]);
  };
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, ...edgeDefaults, id: `e${Date.now()}` }, es)), [setEdges]);
  const onEdgeDoubleClick = async (_: React.MouseEvent, edge: Edge) => {
    if (readOnly) return;
    const label = await prompt({ title: 'Label this connection', label: 'Label', placeholder: 'gRPC, async event, reads, writes…', initial: typeof edge.label === 'string' ? edge.label : '' });
    if (label === null) return;
    setEdges((es) => es.map((e) => (e.id === edge.id ? { ...e, label: label.trim() || undefined } : e)));
  };

  return (
    <div className="diagram" style={readOnly ? { gridTemplateColumns: '1fr', height: 380 } : undefined}>
      {!readOnly && (
        <div className="diagram-palette" aria-label="Components">
          {components.map((c) => (
            <button key={c.key} type="button" onClick={() => add(c)}>
              <span aria-hidden>{ICONS[c.key] ?? '▣'}</span>
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="diagram-canvas" ref={canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
          fitView={readOnly}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="rgba(9,39,66,0.10)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {!readOnly && nodes.length === 0 && (
          <div className="diagram-help">Add components from the left, drag between handles to connect, double-click a line to label it.</div>
        )}
      </div>
    </div>
  );
}

/** Box-and-arrow system diagram editor. Serialises to the API's Diagram shape on every change. */
export default function DiagramEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
