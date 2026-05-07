import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

const FONT = "'Share Tech Mono',monospace";

export default function NetworkTab({ router, localNodeId, peers, visible }) {
  const containerRef = useRef(null);
  const svgRef       = useRef(null);
  const simRef       = useRef(null);
  const nodeMapRef   = useRef(new Map());
  const [tooltip, setTooltip] = useState(null);
  const [stats,   setStats]   = useState({ nodes:0, edges:0 });

  // Init D3
  useEffect(() => {
    const el = containerRef.current;
    if (!el || svgRef.current) return;
    const W = el.clientWidth || 800;
    const H = el.clientHeight || 600;

    const svg = d3.select(el).append('svg')
      .attr('width','100%').attr('height','100%')
      .style('background','#000').style('display','block');
    svgRef.current = svg;

    const defs = svg.append('defs');

    // Glow filters
    const addGlow = (id, col, std=6) => {
      const f = defs.append('filter').attr('id',id).attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
      f.append('feGaussianBlur').attr('in','SourceGraphic').attr('stdDeviation',std).attr('result','blur');
      const merge = f.append('feMerge');
      merge.append('feMergeNode').attr('in','blur');
      merge.append('feMergeNode').attr('in','SourceGraphic');
    };
    addGlow('glow-green','#00FF88',7);
    addGlow('glow-cyan','#00FFFF',8);
    addGlow('glow-red','#FF0000',6);
    addGlow('glow-amber','#FFCC00',6);

    // Grid
    const grid = defs.append('pattern').attr('id','grid').attr('width',50).attr('height',50).attr('patternUnits','userSpaceOnUse');
    grid.append('path').attr('d','M 50 0 L 0 0 0 50').attr('fill','none').attr('stroke','#0a1a0a').attr('stroke-width',0.5);
    svg.append('rect').attr('width','100%').attr('height','100%').attr('fill','url(#grid)');

    const zoom = d3.zoom().scaleExtent([0.2,5]).on('zoom', ev => zoomG.attr('transform', ev.transform));
    svg.call(zoom);

    const zoomG    = svg.append('g');
    const gEdges   = zoomG.append('g');
    const gNodes   = zoomG.append('g');
    const gLabels  = zoomG.append('g');

    const sim = d3.forceSimulation()
      .force('link',   d3.forceLink().id(d=>d.id).distance(160).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-400).distanceMax(500))
      .force('center', d3.forceCenter(W/2, H/2))
      .force('collide',d3.forceCollide(50))
      .alphaDecay(0.025).velocityDecay(0.4);
    simRef.current = sim;

    svg._layers = { gEdges, gNodes, gLabels };
    svg._dims   = { W, H };

    return () => { sim.stop(); svg.remove(); svgRef.current = null; };
  }, []);

  // Update graph
  useEffect(() => {
    const svg = svgRef.current;
    const sim = simRef.current;
    if (!svg || !sim || !router) return;

    const snap  = router.getGraphSnapshot();
    const infos = router.getNodes ? router.getNodes() : [];
    const infoMap = new Map(infos.map(n => [n.nodeId, n]));
    const peerMap = new Map(peers.map(p => [p.nodeId, p]));
    const { gEdges, gNodes, gLabels } = svg._layers;
    const { W, H } = svg._dims;

    setStats({ nodes: snap.nodes.length, edges: snap.edges.length });

    const nodes = snap.nodes.map(id => {
      const peer  = peerMap.get(id);
      const info  = infoMap.get(id);
      const prev  = nodeMapRef.current.get(id);
      const isLocal = id === localNodeId;
      let status = 'offline';
      if (isLocal) status = 'local';
      else if (peer?.state === 'connected') status = 'online';
      else if (peer?.state === 'disconnected') status = 'weak';
      const n = {
        id, isLocal, status,
        userName: (info?.userName ?? peer?.userName ?? id.slice(0,8)).toUpperCase(),
        battery: info?.batteryLevel ?? peer?.nodeInfo?.batteryLevel ?? 100,
        x: prev?.x ?? W/2 + (Math.random()-0.5)*200,
        y: prev?.y ?? H/2 + (Math.random()-0.5)*200,
        vx: prev?.vx ?? 0, vy: prev?.vy ?? 0,
      };
      return n;
    });

    const seen = new Set();
    const links = [];
    for (const e of snap.edges) {
      const k = [e.from,e.to].sort().join('|');
      if (!seen.has(k)) { seen.add(k); links.push({ source:e.from, target:e.to, cost:e.cost }); }
    }

    const nodeColor = d => d.isLocal ? '#00FFFF' : d.status==='online' ? (d.battery<=20?'#FFCC00':'#00FF88') : d.status==='weak' ? '#FF6600' : '#FF3333';
    const nodeFilter = d => d.isLocal ? 'url(#glow-cyan)' : d.status==='online' ? 'url(#glow-green)' : d.status==='weak' ? 'url(#glow-amber)' : 'url(#glow-red)';

    // Edges
    const eSel = gEdges.selectAll('line.edge').data(links, d=>`${d.source}-${d.target}`);
    eSel.exit().transition().duration(400).attr('opacity',0).remove();
    const eEnter = eSel.enter().append('line').attr('class','edge')
      .attr('stroke','#00FF8822').attr('stroke-width',1.5).attr('stroke-linecap','round').attr('opacity',0);
    eEnter.transition().duration(500).attr('opacity',1);
    const eMerge = eEnter.merge(eSel);

    // Edge labels
    const elSel = gEdges.selectAll('text.elabel').data(links, d=>`${d.source}-${d.target}`);
    elSel.exit().remove();
    const elMerge = elSel.enter().append('text').attr('class','elabel')
      .attr('text-anchor','middle').attr('dominant-baseline','middle')
      .attr('fill','#1a3a1a').attr('font-size',9).attr('font-family',FONT)
      .merge(elSel).text(d=>`${d.cost}h`);

    // Nodes
    const nSel = gNodes.selectAll('g.node').data(nodes, d=>d.id);
    nSel.exit().transition().duration(300).attr('opacity',0).remove();

    const nEnter = nSel.enter().append('g').attr('class','node')
      .attr('transform', d=>`translate(${d.x},${d.y})`)
      .style('cursor','pointer')
      .call(d3.drag()
        .on('start',(ev,d)=>{ if(!ev.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
        .on('drag', (ev,d)=>{ d.fx=ev.x; d.fy=ev.y; })
        .on('end',  (ev,d)=>{ if(!ev.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }))
      .on('mouseenter',(ev,d)=>{ setTooltip({ x:ev.clientX, y:ev.clientY, node:d }); })
      .on('mousemove', (ev)=>{ setTooltip(p=>p?{...p,x:ev.clientX,y:ev.clientY}:null); })
      .on('mouseleave',()=>{ setTooltip(null); })
      .on('click',(ev,d)=>{ setTooltip({ x:ev.clientX, y:ev.clientY, node:d, pinned:true }); });

    // Outer glow halo
    nEnter.append('circle').attr('class','halo')
      .attr('r',28).attr('fill','none').attr('stroke',nodeColor).attr('stroke-width',1).attr('opacity',0.15);

    // Main circle
    nEnter.append('circle').attr('class','body')
      .attr('r',22).attr('fill','#0D1F0D').attr('stroke',nodeColor).attr('stroke-width',2)
      .attr('filter',nodeFilter);

    // Inner dot
    nEnter.append('circle').attr('class','dot').attr('r',6).attr('fill',nodeColor);

    // Crosshair for local
    nEnter.filter(d=>d.isLocal).append('g').attr('class','cross').call(g=>{
      g.append('line').attr('x1',-12).attr('x2',12).attr('stroke','#00FFFF').attr('stroke-width',0.8).attr('opacity',0.5);
      g.append('line').attr('y1',-12).attr('y2',12).attr('stroke','#00FFFF').attr('stroke-width',0.8).attr('opacity',0.5);
    });

    const nMerge = nEnter.merge(nSel);
    nMerge.select('circle.body').transition().duration(400)
      .attr('stroke',nodeColor).attr('filter',nodeFilter);
    nMerge.select('circle.dot').transition().duration(400).attr('fill',nodeColor);
    nMerge.select('circle.halo').transition().duration(400).attr('stroke',nodeColor);

    // Labels
    const lSel = gLabels.selectAll('g.label').data(nodes, d=>d.id);
    lSel.exit().transition().duration(300).attr('opacity',0).remove();
    const lEnter = lSel.enter().append('g').attr('class','label').attr('opacity',0).style('pointer-events','none');
    lEnter.append('text').attr('class','lname')
      .attr('text-anchor','middle').attr('dy',32)
      .attr('fill',d=>d.isLocal?'#00FFFF':'#AAFFCC')
      .attr('font-size',11).attr('font-family',FONT).attr('letter-spacing','0.12em')
      .text(d=>d.isLocal?`◈ ${d.userName}`:d.userName);
    lEnter.append('text').attr('class','lid')
      .attr('text-anchor','middle').attr('dy',44)
      .attr('fill','#1a3a1a').attr('font-size',8).attr('font-family',FONT)
      .text(d=>d.id.slice(0,8).toUpperCase());
    lEnter.merge(lSel).transition().duration(400).attr('opacity',1);

    // Simulation
    sim.nodes(nodes).on('tick', () => {
      nodes.forEach(n => {
        const r = n.isLocal ? 30 : 26;
        n.x = Math.max(r, Math.min((svg._dims.W||800)-r, n.x));
        n.y = Math.max(r, Math.min((svg._dims.H||600)-r, n.y));
      });
      eMerge.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
      elMerge.attr('x',d=>(d.source.x+d.target.x)/2).attr('y',d=>(d.source.y+d.target.y)/2);
      nMerge.attr('transform',d=>`translate(${d.x},${d.y})`);
      gLabels.selectAll('g.label').attr('transform',d=>`translate(${d.x},${d.y})`);
      nodes.forEach(n => nodeMapRef.current.set(n.id,{x:n.x,y:n.y,vx:n.vx,vy:n.vy}));
    });
    sim.force('link').links(links);
    sim.alpha(0.4).restart();

  }, [router, peers, localNodeId]);

  // Invalidate when visible
  useEffect(() => {
    if (visible && simRef.current) simRef.current.alpha(0.3).restart();
  }, [visible]);

  return (
    <>
      <style>{`
        .net-root{position:relative;width:100%;height:100%;background:#000;overflow:hidden;}
        .net-stats{
          position:absolute;top:12px;left:12px;z-index:10;
          display:flex;gap:12px;
          background:rgba(0,0,0,0.8);border:1px solid #00FF8833;
          padding:8px 14px;
          backdrop-filter:blur(4px);
          font-family:${FONT};
        }
        .net-stat{display:flex;flex-direction:column;align-items:center;gap:2px;}
        .net-stat-val{font-size:20px;color:#00FF88;line-height:1;}
        .net-stat-lbl{font-size:8px;color:#AAFFCC;letter-spacing:0.15em;}
        .net-hint{
          position:absolute;bottom:12px;left:12px;z-index:10;
          font-family:${FONT};font-size:9px;color:#1a3a1a;letter-spacing:0.12em;
          background:rgba(0,0,0,0.7);padding:5px 10px;border:1px solid #00FF8811;
        }
        .node-tooltip{
          position:fixed;z-index:9999;
          background:rgba(0,0,0,0.92);border:1px solid #00FF8844;
          padding:10px 14px;pointer-events:none;
          font-family:${FONT};font-size:11px;color:#fff;
          min-width:160px;
        }
      `}</style>

      <div className="net-root">
        <div ref={containerRef} style={{ width:'100%', height:'100%' }} />

        <div className="net-stats">
          <div className="net-stat"><span className="net-stat-val">{stats.nodes}</span><span className="net-stat-lbl">NODES</span></div>
          <div className="net-stat"><span className="net-stat-val">{stats.edges}</span><span className="net-stat-lbl">LINKS</span></div>
          <div className="net-stat"><span className="net-stat-val" style={{color:'#00FF88'}}>{peers.filter(p=>p.state==='connected').length}</span><span className="net-stat-lbl">LIVE</span></div>
        </div>

        <div className="net-hint">DRAG NODES · SCROLL TO ZOOM · CLICK FOR INFO</div>

        {tooltip && (
          <div className="node-tooltip" style={{ left: tooltip.x+14, top: tooltip.y-10 }}>
            <div style={{ color: tooltip.node.isLocal ? '#00FFFF' : '#00FF88', marginBottom:6, fontSize:12 }}>
              ◈ {tooltip.node.userName}
            </div>
            <div style={{ color:'#AAFFCC', marginBottom:2 }}>
              STATUS: <span style={{ color: tooltip.node.status==='online'?'#00FF88':tooltip.node.status==='local'?'#00FFFF':'#FF6600' }}>
                {tooltip.node.status.toUpperCase()}
              </span>
            </div>
            {!tooltip.node.isLocal && (
              <div style={{ color:'#AAFFCC' }}>BAT: <span style={{ color: tooltip.node.battery<=20?'#FF6600':'#00FF88' }}>{tooltip.node.battery}%</span></div>
            )}
            <div style={{ color:'#446644', fontSize:9, marginTop:5, borderTop:'1px solid #1a3a1a', paddingTop:5 }}>
              {tooltip.node.id.slice(0,16).toUpperCase()}
            </div>
          </div>
        )}
      </div>
    </>
  );
}