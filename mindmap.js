// Enter the url of the backend api
const apiUrl = 'http://localhost:3000/api'

const ROOT_TERMS = [
    "GO:0008150",
    "GO:0005575", 
    "GO:0003674"
];

const PAGINATION_THRESHOLD = 50; // Paginate families with more than 50 children
const CHILDREN_PER_PAGE = 50;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// Add roundRect support for older browsers
if (!ctx.roundRect) {
    ctx.roundRect = function(x, y, width, height, radius) {
    this.beginPath();
    this.moveTo(x + radius, y);
    this.lineTo(x + width - radius, y);
    this.arcTo(x + width, y, x + width, y + radius, radius);
    this.lineTo(x + width, y + height - radius);
    this.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    this.lineTo(x + radius, y + height);
    this.arcTo(x, y + height, x, y + height - radius, radius);
    this.lineTo(x, y + radius);
    this.arcTo(x, y, x + radius, y, radius);
    this.closePath();
    };
}

let nodes = {}; // Map from GO ID to { x, y, lbl, children: [GO ID], parent, relation_type, currentPage, totalPages, allChildren }
let panX = 0;
let panY = 0;
let zoomLevel = 1;
const minZoom = 0.3;
const maxZoom = 3;
const zoomSpeed = 0.1;

// Performance optimization variables
let isProcessing = false;
let lastClickTime = 0;
const clickDebounceTime = 300; // ms
let renderFrame = null;
let needsRedraw = false;

// Ripple effect variables
let ripples = [];
let toastTimeout = null;
let rippleAnimationId = null;

// Shrinking animation variables
let shrinkingNodes = new Set();
let shrinkingAnimationId = null;

// Web Worker for layout calculations
let layoutWorker = null;
let workerBusy = false;

// PERFORMANCE OPTIMIZATION: Hover detection optimizations
let hoverUpdateFrame = null;
let lastHoverCheckTime = 0;
const hoverCheckInterval = 16; // ~60fps, throttle hover checks
let currentMousePos = { x: 0, y: 0 };
let isMouseOverCanvas = false;

// PERFORMANCE OPTIMIZATION: API response cache
const termCache = new Map();
const cacheTimeout = 5 * 60 * 1000; // 5 minutes

// PERFORMANCE OPTIMIZATION: Debounced API calls
let hoverApiTimeout = null;
const hoverApiDelay = 200; // ms delay before making API call

// PERFORMANCE OPTIMIZATION: Spatial indexing for visible nodes
let visibleNodesByRegion = new Map();
const regionSize = 200; // pixels

// PERFORMANCE OPTIMIZATION: Viewport culling
let viewportBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

let animationFrame = null;
let isAnimating = false;

// Cache API responses with timeout
function getCachedTerm(id) {
    const cached = termCache.get(id);
    if (cached && Date.now() - cached.timestamp < cacheTimeout) {
    return cached.data;
    }
    return null;
}

function setCachedTerm(id, data) {
    termCache.set(id, {
    data: data,
    timestamp: Date.now()
    });
}

// Enhanced API functions with caching
async function fetchGOTerm(id) {
    // Check cache first
    const cached = getCachedTerm(id);
    if (cached) {
    return cached;
    }

    try {
    const res = await fetch(`${apiUrl}/go/${encodeURIComponent(id)}`);
    if (res.ok) {
        const data = await res.json();
        setCachedTerm(id, data);
        return data;
    }
    return null;
    } catch (error) {
    console.error('Error fetching GO term:', error);
    return null;
    }
}

// Batch fetchGOTerm function
async function fetchGOTermsBatch(ids) {
if (!ids || ids.length === 0) return [];

// Check cache first
const cachedResults = [];
const uncachedIds = [];

for (const id of ids) {
    const cached = getCachedTerm(id);
    if (cached) {
    cachedResults.push({ id, term: cached });
    } else {
    uncachedIds.push(id);
    }
}

// If all terms are cached, return them
if (uncachedIds.length === 0) {
    return ids.map(id => cachedResults.find(result => result.id === id)?.term || null);
}

try {
    const res = await fetch(`${apiUrl}/go/batch`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: uncachedIds })
    });
    
    if (!res.ok) {
    throw new Error(`HTTP error! status: ${res.status}`);
    }
    
    const batchResults = await res.json();
    
    // Cache the results
    for (let i = 0; i < uncachedIds.length; i++) {
    const id = uncachedIds[i];
    const term = batchResults[i];

    if (term) {
        setCachedTerm(id, term);
        }
    }
    
    // Combine cached and fetched results in original order
    return ids.map(id => {
        const cached = cachedResults.find(result => result.id === id);
        if (cached) return cached.term;
        
        const index = uncachedIds.indexOf(id);
        return index >= 0 ? batchResults[index] : null;
    });
    
} catch (error) {
    console.error('Error fetching GO terms batch:', error);
    return ids.map(() => null); // Return nulls on error
    }
};

async function fetchChildren(id) {
    try {
    const res = await fetch(`${apiUrl}/go/children/${encodeURIComponent(id)}`);
    return res.ok ? await res.json() : [];
    } catch (error) {
    console.error('Error fetching children:', error);
    return [];
    }
}

// PERFORMANCE OPTIMIZATION: Update viewport bounds for culling
function updateViewportBounds() {
    const margin = 100; // Extra margin for smoother experience
    viewportBounds.minX = (-panX - margin) / zoomLevel;
    viewportBounds.maxX = (canvas.width - panX + margin) / zoomLevel;
    viewportBounds.minY = (-panY - margin) / zoomLevel;
    viewportBounds.maxY = (canvas.height - panY + margin) / zoomLevel;
}

// PERFORMANCE OPTIMIZATION: Check if node is in viewport
function isNodeInViewport(node) {
    const radius = 50; // Node radius + buffer
    return (
    node.x + radius >= viewportBounds.minX &&
    node.x - radius <= viewportBounds.maxX &&
    node.y + radius >= viewportBounds.minY &&
    node.y - radius <= viewportBounds.maxY
    );
}

// PERFORMANCE OPTIMIZATION: Spatial indexing for hover detection
function updateSpatialIndex() {
    visibleNodesByRegion.clear();
    
    for (const id in nodes) {
    const node = nodes[id];
    if (node.visible === false || !isNodeInViewport(node)) continue;
    
    // Calculate which region this node belongs to
    const regionX = Math.floor(node.x / regionSize);
    const regionY = Math.floor(node.y / regionSize);
    const regionKey = `${regionX},${regionY}`;
    
    if (!visibleNodesByRegion.has(regionKey)) {
        visibleNodesByRegion.set(regionKey, []);
    }
    visibleNodesByRegion.get(regionKey).push(node);
    }
}

// PERFORMANCE OPTIMIZATION: Optimized hover detection using spatial indexing
function getHoveredNodeOptimized(mouseX, mouseY) {
    if (!isMouseOverCanvas) return null;
    
    const mousePos = {
    x: (mouseX - panX) / zoomLevel,
    y: (mouseY - panY) / zoomLevel
    };

    // Calculate which regions to check (check current region and adjacent ones)
    const regionX = Math.floor(mousePos.x / regionSize);
    const regionY = Math.floor(mousePos.y / regionSize);
    
    const regionsToCheck = [];
    for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
        regionsToCheck.push(`${regionX + dx},${regionY + dy}`);
    }
    }

    // Check nodes in relevant regions only
    for (const regionKey of regionsToCheck) {
    const nodesInRegion = visibleNodesByRegion.get(regionKey);
    if (!nodesInRegion) continue;
    
    for (const node of nodesInRegion) {
        const dx = mousePos.x - node.x;
        const dy = mousePos.y - node.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance <= 40) {
        return node;
        }
    }
    }
    
    return null;
}

// PERFORMANCE OPTIMIZATION: Throttled hover detection
function throttledHoverCheck() {
    if (hoverUpdateFrame) return;
    
    hoverUpdateFrame = requestAnimationFrame(() => {
    const now = Date.now();
    if (now - lastHoverCheckTime < hoverCheckInterval) {
        hoverUpdateFrame = null;
        return;
    }
    
    lastHoverCheckTime = now;
    
    const hoveredNodeNow = getHoveredNodeOptimized(currentMousePos.x, currentMousePos.y);
    
    if (hoveredNodeNow && hoveredNodeNow !== hoveredNode) {
        hoveredNode = hoveredNodeNow;
        showHoverPanel(hoveredNode, currentMousePos.x, currentMousePos.y);
    } else if (!hoveredNodeNow && hoveredNode) {
        hideHoverPanel();
    }
    
    hoverUpdateFrame = null;
    });
}

// Initialize Web Worker
function initLayoutWorker() {
    const workerScript = `
    // Web Worker script for layout calculations
    function calculateOptimalLayout(parentX, parentY, childCount, preferredDirection) {
        // Calculate maximum radius based on number of children - increased by 25% for families > 20
        let maxRadius;
        if (childCount <= 3) maxRadius = 200;
        else if (childCount <= 6) maxRadius = 245;
        else if (childCount <= 10) maxRadius = 280;
        else if (childCount <= 20) maxRadius = 325;
        else if (childCount <= 50) maxRadius = 350; // 360 * 1.25 = 450
        else maxRadius = 370; // 450 * 1.25 = 562.5, rounded to 560

        // Adaptive angular spread
        let totalAngle;
        if (childCount <= 4) {
        totalAngle = Math.PI; // 180 degrees for few children
        } else if (childCount <= 8) {
        totalAngle = 3 * Math.PI / 2; // 270 degrees for medium
        } else {
        totalAngle = 2 * Math.PI; // Full circle for many
        }

        const positions = [];
        const startAngle = preferredDirection.angle - totalAngle / 2;
        
        for (let i = 0; i < childCount; i++) {
        const angle = startAngle + (i * totalAngle) / Math.max(1, childCount - 1);
        
        // Randomize the radius between 80% and 100% of max radius
        const minRadiusFactor = 0.8;
        const radiusFactor = minRadiusFactor + (Math.random() * (1 - minRadiusFactor));
        const randomRadius = maxRadius * radiusFactor;
        
        const x = parentX + randomRadius * Math.cos(angle);
        const y = parentY + randomRadius * Math.sin(angle);
        positions.push({ x, y, angle, radius: randomRadius });
        }

        return positions;
    }

    function findBestDirection(parentX, parentY, existingNodes) {
        // Test 8 main directions
        const directions = [
        { angle: 0, weight: 0 },           // East
        { angle: Math.PI / 4, weight: 0 }, // Northeast  
        { angle: Math.PI / 2, weight: 0 }, // North
        { angle: 3 * Math.PI / 4, weight: 0 }, // Northwest
        { angle: Math.PI, weight: 0 },     // West
        { angle: 5 * Math.PI / 4, weight: 0 }, // Southwest
        { angle: 3 * Math.PI / 2, weight: 0 }, // South
        { angle: 7 * Math.PI / 4, weight: 0 }  // Southeast
        ];

        // Calculate weights based on existing visible nodes
        for (const nodeId in existingNodes) {
        const node = existingNodes[nodeId];
        if (node.visible === false) continue;
        
        const dx = node.x - parentX;
        const dy = node.y - parentY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 0 && distance < 400) {
            const nodeAngle = Math.atan2(dy, dx);
            
            directions.forEach(dir => {
            let angleDiff = Math.abs(dir.angle - nodeAngle);
            if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
            
            if (angleDiff < Math.PI / 3) {
                dir.weight += (400 - distance) / distance;
            }
            });
        }
        }

        return directions.reduce((best, current) => 
        current.weight < best.weight ? current : best
        );
    }

    function calculatePushMovements(expandedNodeId, expandedNode, newChildrenPositions, allNodes, newChildIds) {
        const movements = {};
        
        // Calculate the bounding box
        const allPositions = [...newChildrenPositions, { x: expandedNode.x, y: expandedNode.y }];
        const childBounds = {
        minX: Math.min(...allPositions.map(p => p.x)),
        maxX: Math.max(...allPositions.map(p => p.x)),
        minY: Math.min(...allPositions.map(p => p.y)),
        maxY: Math.max(...allPositions.map(p => p.y))
        };
        
        // Standard exclusion padding for paginated families
        const exclusionPadding = 250;
        
        childBounds.minX -= exclusionPadding;
        childBounds.maxX += exclusionPadding;
        childBounds.minY -= exclusionPadding;
        childBounds.maxY += exclusionPadding;

        const familyCenterX = (childBounds.minX + childBounds.maxX) / 2;
        const familyCenterY = (childBounds.minY + childBounds.maxY) / 2;

        // Process nodes that need to be moved
        for (const nodeId in allNodes) {
        const node = allNodes[nodeId];
        if (node.visible === false || nodeId === expandedNodeId || newChildIds.includes(nodeId)) continue;
        
        const inExclusionZone = (
            node.x >= childBounds.minX && node.x <= childBounds.maxX &&
            node.y >= childBounds.minY && node.y <= childBounds.maxY
        );

        const dx = node.x - familyCenterX;
        const dy = node.y - familyCenterY;
        const distanceToCenter = Math.sqrt(dx * dx + dy * dy);
        const tooClose = distanceToCenter < (exclusionPadding * 1.3);

        if (inExclusionZone || tooClose) {
            const pushDirection = distanceToCenter > 0 ? 
            { x: dx / distanceToCenter, y: dy / distanceToCenter } : 
            { x: 1, y: 0 };
            
            const basePushDistance = 350;
            const extraPush = Math.max(0, (exclusionPadding * 1.3) - distanceToCenter);
            const totalPushDistance = basePushDistance + extraPush;
            
            const newX = node.x + pushDirection.x * totalPushDistance;
            const newY = node.y + pushDirection.y * totalPushDistance;
            
            movements[nodeId] = { 
            x: newX, 
            y: newY,
            deltaX: pushDirection.x * totalPushDistance,
            deltaY: pushDirection.y * totalPushDistance
            };
        }
        }
        
        return movements;
    }

    // Worker message handler
    self.onmessage = function(e) {
        const { type, data } = e.data;
        
        try {
        switch (type) {
            case 'calculateLayout':
            const { parentX, parentY, childCount, preferredDirection, existingNodes } = data;
            
            // Find best direction
            const bestDirection = findBestDirection(parentX, parentY, existingNodes);
            
            // Calculate positions
            let positions = calculateOptimalLayout(parentX, parentY, childCount, bestDirection);
            
            self.postMessage({
                type: 'layoutComplete',
                data: { positions, bestDirection }
            });
            break;
            
            case 'calculatePushMovements':
            const { expandedNodeId, expandedNode, newChildrenPositions, allNodes, newChildIds } = data;
            const movements = calculatePushMovements(expandedNodeId, expandedNode, newChildrenPositions, allNodes, newChildIds);
            
            self.postMessage({
                type: 'pushMovementsComplete',
                data: { movements }
            });
            break;
        }
        } catch (error) {
        self.postMessage({
            type: 'error',
            data: { error: error.message }
        });
        }
    };
    `;

    const blob = new Blob([workerScript], { type: 'application/javascript' });
    layoutWorker = new Worker(URL.createObjectURL(blob));
    
    layoutWorker.onmessage = function(e) {
    const { type, data } = e.data;
    workerBusy = false;
    
    switch (type) {
        case 'layoutComplete':
        handleLayoutComplete(data);
        break;
        case 'pushMovementsComplete':
        handlePushMovementsComplete(data);
        break;
        case 'error':
        console.error('Worker error:', data.error);
        break;
    }
    };
    
    layoutWorker.onerror = function(error) {
    console.error('Worker error:', error);
    workerBusy = false;
    };
}

// Callback functions for worker results
let pendingLayoutCallback = null;
let pendingPushCallback = null;

function handleLayoutComplete(data) {
    if (pendingLayoutCallback) {
    pendingLayoutCallback(data.positions);
    pendingLayoutCallback = null;
    }
}

function handlePushMovementsComplete(data) {
    if (pendingPushCallback) {
    pendingPushCallback(data.movements);
    pendingPushCallback = null;
    }
}

// Enhanced layout calculation with worker fallback
async function calculateOptimalLayoutAsync(parentX, parentY, childCount, preferredDirection, existingNodes) {
    // For small families or if worker is busy, calculate on main thread
    if (childCount < 8 || workerBusy || !layoutWorker) {
    return calculateOptimalLayoutSync(parentX, parentY, childCount, preferredDirection);
    }
    
    return new Promise((resolve) => {
    workerBusy = true;
    pendingLayoutCallback = resolve;
    
    layoutWorker.postMessage({
        type: 'calculateLayout',
        data: { parentX, parentY, childCount, preferredDirection, existingNodes }
    });
    });
}

// Enhanced push calculation with worker
async function calculatePushMovementsAsync(expandedNodeId, newChildrenPositions, newChildIds = []) {
    const expandedNode = nodes[expandedNodeId];
    if (!expandedNode) return {};
    
    // For small families or if worker is busy, calculate on main thread
    if (newChildrenPositions.length < 8 || workerBusy || !layoutWorker) {
    return calculatePushMovementsSync(expandedNodeId, newChildrenPositions);
    }
    
    return new Promise((resolve) => {
    workerBusy = true;
    pendingPushCallback = resolve;
    
    layoutWorker.postMessage({
        type: 'calculatePushMovements',
        data: { 
        expandedNodeId, 
        expandedNode, 
        newChildrenPositions,
        newChildIds, 
        allNodes: nodes 
        }
    });
    });
}

const colorsByrelation_type = {
    "is_a": "#3490dc", //blue 
    "part_of": "#38c172", // 'part of' is a teal-green line
    "positively_regulates": "#ffed4a", // 'postively regulates' is a yellow line
    "negatively_regulates": "#8b0000", // 'negatively regulates' is a dark red line 
    "regulates": "#1a237e" // 'regulates' is a dark blue/navy line
};

// Family colors for glassmorphism effect
const familyColors = {
    "GO:0008150": {
    bg: "rgba(59, 130, 246, 0.15)", // Blue glass
    border: "rgba(59, 130, 246, 0.3)",
    text: "rgba(30, 64, 175, 0.9)"
    },
    "GO:0005575": {
    bg: "rgba(34, 197, 94, 0.15)", // Green glass
    border: "rgba(34, 197, 94, 0.3)", 
    text: "rgba(21, 128, 61, 0.9)"
    },
    "GO:0003674": {
    bg: "rgba(239, 68, 68, 0.15)", // Red glass
    border: "rgba(239, 68, 68, 0.3)",
    text: "rgba(153, 27, 27, 0.9)"
    }
};

function getRootFamily(nodeId) {
    let current = nodes[nodeId];
    while (current && current.parent) {
    current = nodes[current.parent];
    }
    return current ? current.id : null;
}

function getFamilyStyle(nodeId) {
    const rootFamily = getRootFamily(nodeId);
    return familyColors[rootFamily] || {
    bg: "rgba(255, 255, 255, 0.15)", // Default glass
    border: "rgba(255, 255, 255, 0.3)",
    text: "rgba(0, 0, 0, 0.8)"
    };
}

function getRippleColor(nodeId) {
    const rootFamily = getRootFamily(nodeId);
    const rippleColors = {
    "GO:0008150": "rgba(59, 130, 246, 1)", // Blue
    "GO:0005575": "rgba(34, 197, 94, 1)", // Green
    "GO:0003674": "rgba(239, 68, 68, 1)"  // Red
    };
    return rippleColors[rootFamily] || "rgba(156, 163, 175, 1)"; // Gray default
}

function startShrinking(nodeId) {
    shrinkingNodes.add(nodeId);
    
    // Start shrinking animation if not already running
    if (!shrinkingAnimationId) {
    shrinkingAnimationId = requestAnimationFrame(animateShrinking);
    }
}

function stopShrinking(nodeId) {
    shrinkingNodes.delete(nodeId);
    
    // Stop shrinking animation if no more shrinking nodes
    if (shrinkingNodes.size === 0 && shrinkingAnimationId) {
    cancelAnimationFrame(shrinkingAnimationId);
    shrinkingAnimationId = null;
    }
}

function animateShrinking() {
    if (shrinkingNodes.size > 0) {
    requestRedraw();
    shrinkingAnimationId = requestAnimationFrame(animateShrinking);
    } else {
    shrinkingAnimationId = null;
    }
}

function getShrinkScale(nodeId) {
    if (!shrinkingNodes.has(nodeId)) return 1;
    
    const time = Date.now();
    const shrinkSpeed = 0.002; // Adjust for shrink speed
    const scale = 0.8 + 0.1 * Math.sin(time * shrinkSpeed); // Shrink between 0.7 and 0.9
    return scale;
}

function drawRipples() {
    for (let i = ripples.length - 1; i >= 0; i--) {
    const ripple = ripples[i];
    const progress = (Date.now() - ripple.startTime) / ripple.duration;
    
    if (progress >= 1) {
        ripples.splice(i, 1);
        continue;
    }
    
    ctx.save();
    
    // Calculate ripple properties
    const currentRadius = ripple.maxRadius * progress;
    const opacity = Math.max(0, (1 - progress) * 0.6);
    
    // Draw ripple circle
    ctx.beginPath();
    ctx.arc(
        (ripple.x * zoomLevel) + panX,
        (ripple.y * zoomLevel) + panY,
        currentRadius * zoomLevel,
        0,
        Math.PI * 2
    );
    
    ctx.strokeStyle = ripple.color.replace('1)', `${opacity})`);
    ctx.lineWidth = 3 * zoomLevel;
    ctx.stroke();
    
    // Draw inner filled circle that shrinks
    const innerRadius = (ripple.maxRadius * 0.3) * (1 - progress);
    if (innerRadius > 0) {
        ctx.beginPath();
        ctx.arc(
        (ripple.x * zoomLevel) + panX,
        (ripple.y * zoomLevel) + panY,
        innerRadius * zoomLevel,
        0,
        Math.PI * 2
        );
        ctx.fillStyle = ripple.color.replace('1)', `${opacity * 0.3})`);
        ctx.fill();
    }
    
    ctx.restore();
    }
}

function animateRipples() {
    if (ripples.length > 0) {
    requestRedraw();
    rippleAnimationId = requestAnimationFrame(animateRipples);
    } else {
    rippleAnimationId = null;
    }
}

function createRipple(x, y, color) {
    ripples.push({
    x: x,
    y: y,
    startTime: Date.now(),
    duration: 800, // ms
    maxRadius: 80,
    color: color
    });
    
    // Start ripple animation if not already running
    if (!rippleAnimationId) {
    rippleAnimationId = requestAnimationFrame(animateRipples);
    }
}

function showToast() {
    const toast = document.getElementById('toast-notification');
    
    // Clear any existing timeout
    if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
    }
    
    // Show toast
    toast.classList.add('visible');
    
    // Hide after 2 seconds
    toastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
    toastTimeout = null;
    }, 2000);
}

function drawLine(x1, y1, x2, y2, relation_type) {
    const startX = (x1 * zoomLevel) + panX;
    const startY = (y1 * zoomLevel) + panY;
    const endX = (x2 * zoomLevel) + panX;
    const endY = (y2 * zoomLevel) + panY;
    const radius = 40 * zoomLevel;
    
    // Calculate line direction
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return;
    
    // Normalize direction
    const dirX = dx / length;
    const dirY = dy / length;
    
    // Calculate intersection points with circles
    const startOffsetX = startX + (dirX * radius);
    const startOffsetY = startY + (dirY * radius);
    const endOffsetX = endX - (dirX * radius);
    const endOffsetY = endY - (dirY * radius);
    
    ctx.save();
    
    // Create gradient for line that fades near circles
    const gradient = ctx.createLinearGradient(startOffsetX, startOffsetY, endOffsetX, endOffsetY);
    const color = colorsByrelation_type[relation_type] || colorsByrelation_type.default;
    
    // Extract RGB from hex color
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`); // Transparent at start
    gradient.addColorStop(0.15, `rgba(${r}, ${g}, ${b}, 0.3)`); // Fade in
    gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 1)`); // Full opacity in middle
    gradient.addColorStop(0.85, `rgba(${r}, ${g}, ${b}, 0.3)`); // Fade out
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`); // Transparent at end
    
    ctx.beginPath();
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2 * zoomLevel;
    ctx.moveTo(startOffsetX, startOffsetY);
    ctx.lineTo(endOffsetX, endOffsetY);
    ctx.stroke();
    
    ctx.restore();
}

function transformNodeLabel(label) {
    if (!label) return label;
    
    // Apply regex transformations to shorten common terms
    let transformed = label
    .replace(/positive regulation/gi, '+ reg')
    .replace(/negative regulation/gi, '- reg');
    
    return transformed;
}

function drawCircle(node) {
    const x = (node.x * zoomLevel) + panX;
    const y = (node.y * zoomLevel) + panY;
    const shrinkScale = getShrinkScale(node.id);
    const radius = 40 * zoomLevel * shrinkScale;
    const style = getFamilyStyle(node.id);
    
    // Create glassmorphism effect with background blur
    ctx.save();
    
    // Create backdrop blur effect by drawing multiple layered circles
    const blurLayers = 3;
    for (let i = blurLayers; i > 0; i--) {
    const blurRadius = radius + (i * 8 * zoomLevel * shrinkScale);
    const blurOpacity = 0.05 * (blurLayers - i + 1);
    
    ctx.beginPath();
    ctx.arc(x, y, blurRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${blurOpacity})`;
    ctx.fill();
    }
    
    // Draw shadow (also scales with shrink)
    ctx.beginPath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.arc(x + (2 * zoomLevel), y + (2 * zoomLevel), radius, 0, Math.PI * 2);
    ctx.fill();
    
    // Apply blur filter if supported
    if (ctx.filter !== undefined) {
    ctx.filter = `blur(${2 * zoomLevel * shrinkScale}px)`;
    
    // Draw background blur circle
    ctx.beginPath();
    ctx.arc(x, y, radius + (6 * zoomLevel * shrinkScale), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.fill();
    
    // Reset filter
    ctx.filter = 'none';
    }
    
    // Draw main circle with glassmorphism
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    
    // Create gradient for more glass-like effect
    const gradient = ctx.createRadialGradient(
    x - (10 * zoomLevel * shrinkScale), y - (10 * zoomLevel * shrinkScale), 0, 
    x, y, radius
    );
    gradient.addColorStop(0, style.bg.replace('0.15', '0.25')); // Brighter center
    gradient.addColorStop(1, style.bg);
    
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Draw border with glassmorphism
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1.5 * zoomLevel * shrinkScale;
    ctx.stroke();
    
    // Add inner highlight for glass effect (scales with shrink)
    ctx.beginPath();
    ctx.arc(x - (8 * zoomLevel * shrinkScale), y - (8 * zoomLevel * shrinkScale), 12 * zoomLevel * shrinkScale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fill();
    
    // Add outer glow for enhanced blur effect
    ctx.beginPath();
    ctx.arc(x, y, radius + (4 * zoomLevel * shrinkScale), 0, Math.PI * 2);
    ctx.strokeStyle = style.border.replace('0.3', '0.08');
    ctx.lineWidth = 3 * zoomLevel * shrinkScale;
    ctx.stroke();
    
    ctx.restore();
    
    // Draw text with family color - scale font size with zoom and shrink
    ctx.fillStyle = style.text;
    ctx.font = `${12 * zoomLevel * shrinkScale}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    // Only draw text if zoom level is reasonable for readability
    if (zoomLevel > 0.4) {
    // Transform the label to shorten common terms
    const transformedLabel = transformNodeLabel(node.name);
    
    // Split long labels into multiple lines
    const words = transformedLabel.split('_');
    if (words.length > 1 && transformedLabel.length > 12) {
        ctx.fillText(words[0], x, y - (6 * zoomLevel * shrinkScale));
        ctx.fillText(words.slice(1).join('_').slice(0, 10), x, y + (6 * zoomLevel * shrinkScale));
    } else {
        ctx.fillText(transformedLabel.slice(0, 12), x, y);
    }
    }
}

function drawPaginationControls(node, x, y, radius, style) {
    const pageIndicatorY = y + radius + (25 * zoomLevel);
    const currentPage = node.currentPage || 1;
    const totalPages = node.totalPages || 1;
    
    // Draw page number with glassmorphism
    ctx.save();
    
    // Page number background
    const pageWidth = 40 * zoomLevel;
    const pageHeight = 20 * zoomLevel;
    const pageX = x - (pageWidth / 2);
    const pageY = pageIndicatorY - (pageHeight / 2);
    
    ctx.beginPath();
    ctx.roundRect(pageX, pageY, pageWidth, pageHeight, 8 * zoomLevel);
    ctx.fillStyle = style.bg;
    ctx.fill();
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1 * zoomLevel;
    ctx.stroke();
    
    // Page number text
    ctx.fillStyle = style.text;
    ctx.font = `${10 * zoomLevel}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${currentPage}/${totalPages}`, x, pageIndicatorY);
    
    // Draw arrows
    const arrowSize = 15 * zoomLevel;
    const arrowY = pageIndicatorY;
    
    // Left arrow (if not first page)
    if (currentPage > 1) {
    const leftArrowX = x - (pageWidth / 2) - (arrowSize * 1.5);
    drawArrow(leftArrowX, arrowY, arrowSize, 'left', style, node.id);
    }
    
    // Right arrow (if not last page)
    if (currentPage < totalPages) {
    const rightArrowX = x + (pageWidth / 2) + (arrowSize * 1.5);
    drawArrow(rightArrowX, arrowY, arrowSize, 'right', style, node.id);
    }
    
    ctx.restore();
}

function drawArrow(x, y, size, direction, style, nodeId) {
    ctx.save();
    
    // Arrow background with glassmorphism
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = style.bg;
    ctx.fill();
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1 * zoomLevel;
    ctx.stroke();
    
    // Arrow shape
    ctx.beginPath();
    ctx.fillStyle = style.text;
    
    const arrowWidth = size * 0.6;
    const arrowHeight = size * 0.4;
    
    if (direction === 'left') {
    ctx.moveTo(x + arrowWidth * 0.3, y - arrowHeight);
    ctx.lineTo(x - arrowWidth * 0.3, y);
    ctx.lineTo(x + arrowWidth * 0.3, y + arrowHeight);
    } else {
    ctx.moveTo(x - arrowWidth * 0.3, y - arrowHeight);
    ctx.lineTo(x + arrowWidth * 0.3, y);
    ctx.lineTo(x - arrowWidth * 0.3, y + arrowHeight);
    }
    
    ctx.fill();
    
    // Store arrow bounds for click detection - use SCREEN coordinates for simpler detection
    if (!window.arrowClickAreas) window.arrowClickAreas = {};
    
    const clickArea = {
    x: x - size,
    y: y - size,
    width: size * 2,
    height: size * 2,
    nodeId: nodeId,
    direction: direction
    };
    
    window.arrowClickAreas[`${nodeId}-${direction}`] = clickArea;
    
    ctx.restore();
}

function requestRedraw() {
    if (needsRedraw || renderFrame) return;
    
    needsRedraw = true;
    renderFrame = requestAnimationFrame(() => {
    redrawCanvas();
    needsRedraw = false;
    renderFrame = null;
    });
}

function redrawCanvas() {
    // PERFORMANCE OPTIMIZATION: Update viewport bounds for culling
    updateViewportBounds();
    
    // PERFORMANCE OPTIMIZATION: Update spatial index for hover detection
    updateSpatialIndex();
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Clear arrow click areas
    if (window.arrowClickAreas) {
        window.arrowClickAreas = {};
    }
    
    // Early exit if no nodes
    if (Object.keys(nodes).length === 0) return;
    
    // Collect visible nodes in viewport (for performance)
    const visibleNodes = [];
    const nodesWithPagination = [];
    
    for (const id in nodes) {
        const node = nodes[id];
        if (node.visible === false || !isNodeInViewport(node)) continue;
        
        visibleNodes.push(node);
        
        // Check if node has pagination controls
        if (node.totalPages && node.totalPages > 1) {
        nodesWithPagination.push(node);
        }
    }
    
    // Collect ALL connections regardless of viewport (no culling for lines)
    const visibleConnections = [];
    for (const id in nodes) {
        const node = nodes[id];
        if (node.visible === false) continue; // Only skip if node is hidden, not if outside viewport
        
        for (const childId of node.children) {
        const child = nodes[childId];
        if (child && child.visible !== false) { // Only check visibility, not viewport
            visibleConnections.push({ parent: node, child: child });
        }
        }
    }
    
    // Draw all connections first (including those outside viewport)
    ctx.save();
    for (const connection of visibleConnections) {
        drawLine(connection.parent.x, connection.parent.y, connection.child.x, connection.child.y, connection.child.relation_type);
    }
    ctx.restore();
    
    // Draw only visible nodes (viewport culled for performance)
    ctx.save();
    for (const node of visibleNodes) {
        drawCircle(node);
    }
    ctx.restore();
    
    // Draw pagination controls ON TOP of everything else
    ctx.save();
    for (const node of nodesWithPagination) {
        const x = (node.x * zoomLevel) + panX;
        const y = (node.y * zoomLevel) + panY;
        const shrinkScale = getShrinkScale(node.id);
        const radius = 40 * zoomLevel * shrinkScale;
        const style = getFamilyStyle(node.id);
        
        drawPaginationControls(node, x, y, radius, style);
    }
    ctx.restore();
    
    // Draw ripples on top of everything
    if (ripples.length > 0) {
        drawRipples();
    }
}

function findBestDirection(parentX, parentY, existingNodes) {
    // Test 8 main directions
    const directions = [
    { angle: 0, weight: 0 },           // East
    { angle: Math.PI / 4, weight: 0 }, // Northeast  
    { angle: Math.PI / 2, weight: 0 }, // North
    { angle: 3 * Math.PI / 4, weight: 0 }, // Northwest
    { angle: Math.PI, weight: 0 },     // West
    { angle: 5 * Math.PI / 4, weight: 0 }, // Southwest
    { angle: 3 * Math.PI / 2, weight: 0 }, // South
    { angle: 7 * Math.PI / 4, weight: 0 }  // Southeast
    ];

    // Calculate weights based on existing visible nodes
    for (const nodeId in existingNodes) {
    const node = existingNodes[nodeId];
    if (node.visible === false) continue;
    
    const dx = node.x - parentX;
    const dy = node.y - parentY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance > 0 && distance < 400) { // Only consider nearby nodes
        const nodeAngle = Math.atan2(dy, dx);
        
        // Add weight to directions that would place children near existing nodes
        directions.forEach(dir => {
        let angleDiff = Math.abs(dir.angle - nodeAngle);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        if (angleDiff < Math.PI / 3) { // Within 60 degrees
            dir.weight += (400 - distance) / distance; // Closer nodes have more weight
        }
        });
    }
    }

    // Find direction with lowest weight (least crowded)
    return directions.reduce((best, current) => 
    current.weight < best.weight ? current : best
    );
}

// Synchronous fallback functions for main thread
function calculateOptimalLayoutSync(parentX, parentY, childCount, preferredDirection) {

    console.log('Synchronous fallback functions for main thread')
    // Calculate maximum radius based on number of children - increased by 25% for families > 20
    let maxRadius;
    if (childCount <= 3) maxRadius = 200;
    else if (childCount <= 6) maxRadius = 245;
    else if (childCount <= 10) maxRadius = 280;
    else if (childCount <= 20) maxRadius = 325;
    else if (childCount <= 50) maxRadius = 350; // 360 * 1.25 = 450
    else maxRadius = 370; // 450 * 1.25 = 562.5, rounded to 560

    // Adaptive angular spread
    let totalAngle;
    if (childCount <= 4) {
    totalAngle = Math.PI; // 180 degrees for few children
    } else if (childCount <= 8) {
    totalAngle = 3 * Math.PI / 2; // 270 degrees for medium
    } else {
    totalAngle = 2 * Math.PI; // Full circle for many
    }

    const positions = [];
    const startAngle = preferredDirection.angle - totalAngle / 2;
    
    for (let i = 0; i < childCount; i++) {
    const angle = startAngle + (i * totalAngle) / Math.max(1, childCount - 1);
    
    // Randomize the radius between 80% and 100% of max radius
    const minRadiusFactor = 0.8;
    const radiusFactor = minRadiusFactor + (Math.random() * (1 - minRadiusFactor));
    const randomRadius = maxRadius * radiusFactor;
    
    const x = parentX + randomRadius * Math.cos(angle);
    const y = parentY + randomRadius * Math.sin(angle);
    positions.push({ x, y, angle, radius: randomRadius });
    }

    return positions;
}

function avoidOverlaps(positions, existingNodes, minDistance = 60) {
    const adjustedPositions = [...positions];
    
    for (let i = 0; i < adjustedPositions.length; i++) {
    let pos = adjustedPositions[i];
    let adjusted = false;
    
    // Check against existing visible nodes
    for (const nodeId in existingNodes) {
        const node = existingNodes[nodeId];
        if (node.visible === false) continue;
        
        const dx = pos.x - node.x;
        const dy = pos.y - node.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < minDistance) {
        // Push away from existing node
        const pushAngle = Math.atan2(dy, dx);
        const pushDistance = minDistance - distance + 20;
        pos.x += pushDistance * Math.cos(pushAngle);
        pos.y += pushDistance * Math.sin(pushAngle);
        adjusted = true;
        }
    }
    
    // Check against other new positions with adaptive minimum distance
    const adaptiveMinDistance = Math.max(80, minDistance - (adjustedPositions.length * 2));
    
    for (let j = 0; j < adjustedPositions.length; j++) {
        if (i === j) continue;
        
        const other = adjustedPositions[j];
        const dx = pos.x - other.x;
        const dy = pos.y - other.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < adaptiveMinDistance) {
        // Push positions apart
        const pushAngle = Math.atan2(dy, dx);
        const pushDistance = (adaptiveMinDistance - distance) / 2 + 10;
        pos.x += pushDistance * Math.cos(pushAngle);
        pos.y += pushDistance * Math.sin(pushAngle);
        other.x -= pushDistance * Math.cos(pushAngle);
        other.y -= pushDistance * Math.sin(pushAngle);
        adjusted = true;
        }
    }
    
    adjustedPositions[i] = pos;
    }
    
    return adjustedPositions;
}

function calculatePushMovementsSync(expandedNodeId, newChildrenPositions, newChildIds = []) {
    const expandedNode = nodes[expandedNodeId];
    if (!expandedNode) return {};

    const movements = {};
    
    // Calculate the bounding box of the new children plus parent
    const allPositions = [...newChildrenPositions, { x: expandedNode.x, y: expandedNode.y }];
    const childBounds = {
    minX: Math.min(...allPositions.map(p => p.x)),
    maxX: Math.max(...allPositions.map(p => p.x)),
    minY: Math.min(...allPositions.map(p => p.y)),
    maxY: Math.max(...allPositions.map(p => p.y))
    };
    
    // Standard exclusion padding for paginated families
    const exclusionPadding = 250;
    
    childBounds.minX -= exclusionPadding;
    childBounds.maxX += exclusionPadding;
    childBounds.minY -= exclusionPadding;
    childBounds.maxY += exclusionPadding;

    // Calculate the center of the expanded family
    const familyCenterX = (childBounds.minX + childBounds.maxX) / 2;
    const familyCenterY = (childBounds.minY + childBounds.maxY) / 2;

    // Find all nodes that need to be moved
    for (const nodeId in nodes) {
    const node = nodes[nodeId];
    if (node.visible === false) continue; // Skip hidden nodes
    
    // Skip nodes that are part of the expanded family
    if (nodeId === expandedNodeId || isDescendantOf(nodeId, expandedNodeId) || newChildIds.includes(nodeId)) {
        continue;
    }

    // Check if node is within the exclusion zone or too close
    const inExclusionZone = (
        node.x >= childBounds.minX && node.x <= childBounds.maxX &&
        node.y >= childBounds.minY && node.y <= childBounds.maxY
    );

    // Distance check
    const dx = node.x - familyCenterX;
    const dy = node.y - familyCenterY;
    const distanceToCenter = Math.sqrt(dx * dx + dy * dy);
    const tooClose = distanceToCenter < (exclusionPadding * 1.3);

    if (inExclusionZone || tooClose) {
        // Calculate push direction from family center
        const pushDirection = distanceToCenter > 0 ? 
        { x: dx / distanceToCenter, y: dy / distanceToCenter } : 
        { x: 1, y: 0 }; // Default direction if at center
        
        const basePushDistance = 350;
        const extraPush = Math.max(0, (exclusionPadding * 1.3) - distanceToCenter);
        const totalPushDistance = basePushDistance + extraPush;
        
        const newX = node.x + pushDirection.x * totalPushDistance;
        const newY = node.y + pushDirection.y * totalPushDistance;
        
        movements[nodeId] = { 
        x: newX, 
        y: newY,
        deltaX: pushDirection.x * totalPushDistance,
        deltaY: pushDirection.y * totalPushDistance
        };
        
        // Move this node's entire family tree
        moveEntireFamily(nodeId, pushDirection.x * totalPushDistance, pushDirection.y * totalPushDistance, movements);
    }
    }
    
    return movements;
}

function hideAllDescendants(nodeId) {
    const node = nodes[nodeId];
    if (!node) return;
    
    // Use iterative approach instead of recursion for better performance
    const stack = [...node.children];
    
    while (stack.length > 0) {
    const childId = stack.pop();
    const child = nodes[childId];
    if (child) {
        child.visible = false;
        // Add children to stack for processing
        stack.push(...child.children);
    }
    }
}

function showDirectChildren(nodeId) {
    const node = nodes[nodeId];
    if (!node) return;
    
    // Simple loop - no recursion needed
    for (const childId of node.children) {
    const child = nodes[childId];
    if (child) {
        child.visible = true;
    }
    }
}

function getCurrentPageChildren(node) {
    if (!node.allChildren || node.allChildren.length === 0) return [];
    
    const currentPage = node.currentPage || 1;
    const startIndex = (currentPage - 1) * CHILDREN_PER_PAGE;
    const endIndex = Math.min(startIndex + CHILDREN_PER_PAGE, node.allChildren.length);
    
    return node.allChildren.slice(startIndex, endIndex);
}

function hideCurrentPageChildren(nodeId) {
    const node = nodes[nodeId];
    if (!node) return;
    
    // Hide all visible children
    for (const childId of node.children) {
    const child = nodes[childId];
    if (child) {
        child.visible = false;
    }
    }
}

function showCurrentPageChildren(nodeId) {
    const node = nodes[nodeId];
    if (!node) return;
    
    // Show only current page children
    const currentPageChildren = getCurrentPageChildren(node);
    node.children = currentPageChildren;
    
    for (const childId of currentPageChildren) {
    const child = nodes[childId];
    if (child) {
        child.visible = true;
    }
    }
}

function navigateToPage(nodeId, direction) {
    const node = nodes[nodeId];
    if (!node || !node.totalPages || node.totalPages <= 1) return;
    
    const currentPage = node.currentPage || 1;
    let newPage = currentPage;
    
    if (direction === 'left' && currentPage > 1) {
    newPage = currentPage - 1;
    } else if (direction === 'right' && currentPage < node.totalPages) {
    newPage = currentPage + 1;
    }
    
    console.log(`Navigating from page ${currentPage} to page ${newPage} for node ${nodeId}`);
    
    if (newPage !== currentPage) {
    // Hide current page children
    hideCurrentPageChildren(nodeId);
    
    // Update page and show new page children
    showPaginatedPage(nodeId, newPage);
    }
}

async function toggleNode(id) {
    // Debounce rapid clicks
    const currentTime = Date.now();
    if (isProcessing || currentTime - lastClickTime < clickDebounceTime) {
    return;
    }
    
    lastClickTime = currentTime;
    isProcessing = true;

    try {
    if (!nodes[id] || isAnimating) return;

    // Start shrinking animation during API call
        startShrinking(id);

    const parent = nodes[id];

    // If node has no children (already checked before), show ripple effect
    if (parent.childrenLoaded && parent.hasChildren === false) {
        const rippleColor = getRippleColor(id);
        createRipple(parent.x, parent.y, rippleColor);
        showToast();
        requestRedraw();
        return;
    }

    // If children are currently visible, hide them
    if (parent.childrenLoaded && parent.children.some(childId => nodes[childId]?.visible !== false)) {
        hideAllDescendants(id);
        requestRedraw();
        return;
    }

    // If node has no children loaded yet, fetch and show them
    if (!parent.childrenLoaded) {
        
        const children = await fetchChildren(id);
        

        if (children.length === 0) {
        parent.childrenLoaded = true;
        parent.hasChildren = false;
        
        // Create ripple effect and show toast
        const rippleColor = getRippleColor(id);
        createRipple(parent.x, parent.y, rippleColor);
        showToast();
        
        requestRedraw();
        return;
        }

        // Determine if pagination is needed
        const needsPagination = children.length > PAGINATION_THRESHOLD;
        
        if (needsPagination) {
        // Setup pagination
        parent.currentPage = 1;
        parent.totalPages = Math.ceil(children.length / CHILDREN_PER_PAGE);
        parent.allChildren = [];
        parent.childrenData = children; // Store raw children data for later processing
        
        // PERFORMANCE OPTIMIZATION: Add ALL child IDs to allChildren immediately
        // so pagination navigation works, but only process first page fully
        for (const child of children) {
            parent.allChildren.push(child.child_go_id);
        }
        
        // Process first page children immediately for quick display
        const firstPageChildren = children.slice(0, CHILDREN_PER_PAGE);
        const remainingChildren = children.slice(CHILDREN_PER_PAGE);
        
        // Extract all child IDs for the first page
        const firstPageChildIds = firstPageChildren.map(child => child.child_go_id);

        // Fetch all terms in one batch
        const batchTerms = await fetchGOTermsBatch(firstPageChildIds);

        // Create child nodes using batch results
        const firstPageNodes = firstPageChildren.map((child, index) => {
            const term = batchTerms[index];
            if (!term) return null;

            return {
                id: child.child_go_id,
                name: term.name || child.child_go_id,
                parent: id,
                relation_type: child.relation_type,
                children: [],
                childrenLoaded: false,
                visible: false,
                hasChildren: true
            };
        }).filter(node => node !== null);
        
        // Store first page nodes
        for (const node of firstPageNodes) {
            if (node) {
            nodes[node.id] = node;
            }
        }
        
        // Show first page immediately
        await showPaginatedPage(id, 1);
        parent.childrenLoaded = true; // Mark as loaded so UI doesn't block
        
        // Process remaining children in background if there are any
        if (remainingChildren.length > 0) {
            processRemainingChildrenInBackground(id, remainingChildren);
        }
        
        } else {
        // Use existing logic for small families
        // Find the best direction to place children
        const bestDirection = findBestDirection(parent.x, parent.y, nodes);
        
        // Calculate optimal positions with randomized distances
        let positions = await calculateOptimalLayoutAsync(parent.x, parent.y, children.length, bestDirection);
        positions = avoidOverlaps(positions, nodes);

        //Get childIds
        const childIds = children.map(child => child.child_go_id);

        //Batch fetch
        const batchTerms = await fetchGOTermsBatch(childIds);

        // Store the new children positions for the animation
        const newChildrenPositions = [];

        // Create child nodes
        const childNodes = children.map((child, i) => {
            const term = batchTerms[i];
            if (!term) return null;

            const pos = positions[i];
            return {
            id: child.child_go_id,
            name: term.name || child.child_go_id,
            x: pos.x,
            y: pos.y,
            parent: id,
            relation_type: child.relation_type,
            children: [],
            childrenLoaded: false,
            visible: true,
            hasChildren: true,
            pos: pos
            };
        });
        
        // Add nodes to the graph
        for (const node of childNodes) {
            if (node) {
            nodes[node.id] = node;
            parent.children.push(node.id);
            newChildrenPositions.push(node.pos);

            //Debug logging
            const dx = node.x - parent.x;
            const dy = node.y - parent.y;
            const actualDistance = Math.sqrt(dx * dx + dy * dy);
            }
        }
        
        // Move other families away with animation
        await moveOtherFamiliesAwayAsync(id, newChildrenPositions);
        parent.childrenLoaded = true;
        }
        
        // If no animation was triggered, just redraw
        if (!isAnimating) {
        requestRedraw();
        }
    } else {
        // Children exist but are hidden, show them
        if (parent.totalPages && parent.totalPages > 1) {
        // Show current page for paginated families
        showCurrentPageChildren(id);
        } else {
        // Show all children for small families
        showDirectChildren(id);
        }
        requestRedraw();
    }
    } finally {
    // Stop shrinking animation
        stopShrinking(id);
    isProcessing = false;
    }
}

// Process remaining children in background without blocking UI
async function processRemainingChildrenInBackground(parentId, remainingChildren) {
    console.log(`Processing ${remainingChildren.length} remaining children in background for ${parentId}`);

    const batchSize = 50; // Increased from 10 to 50
    
    for (let i = 0; i < remainingChildren.length; i += batchSize) {
        const batch = remainingChildren.slice(i, i + batchSize);
        
        // Extract child IDs for batch fetching
        const childIds = batch.map(child => child.child_go_id);
        
        // Fetch all terms in one batch API call (up to 50 terms)
        const batchTerms = await fetchGOTermsBatch(childIds);
        
        // Process batch results
        const batchNodes = batch.map((child, index) => {
        const term = batchTerms[index];
        if (!term) return null;

        return {
            id: child.child_go_id,
            name: term.name || child.child_go_id,
            parent: parentId,
            relation_type: child.relation_type,
            children: [],
            childrenLoaded: false,
            visible: false,
            hasChildren: true
        };
        }).filter(node => node !== null);
        
        // Add to nodes
        for (const node of batchNodes) {
        if (node) {
            nodes[node.id] = node;
        }
        }
        
        // Small delay to prevent blocking UI
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    console.log(`Finished processing remaining children for ${parentId}`);
}

async function showPaginatedPage(nodeId, pageNumber) {
    const parent = nodes[nodeId];
    if (!parent || !parent.allChildren) return;
    
    parent.currentPage = pageNumber;
    
    // Get children for this page
    const currentPageChildren = getCurrentPageChildren(parent);
    
    // Find the best direction to place children
    const bestDirection = findBestDirection(parent.x, parent.y, nodes);
    
    // Calculate optimal positions
    let positions = await calculateOptimalLayoutAsync(parent.x, parent.y, currentPageChildren.length, bestDirection);
    positions = avoidOverlaps(positions, nodes);
    
    // Update positions and make visible
    const newChildrenPositions = [];
    for (let i = 0; i < currentPageChildren.length; i++) {
    const childId = currentPageChildren[i];
    const child = nodes[childId];
    if (child) {
        const pos = positions[i];
        child.x = pos.x;
        child.y = pos.y;
        child.visible = true;
        newChildrenPositions.push(pos);
    }
    }
    
    // Update parent's children array to current page
    parent.children = currentPageChildren;
    
    // Move other families away if this is the first page
    if (pageNumber === 1) {
    await moveOtherFamiliesAwayAsync(nodeId, newChildrenPositions);
    }
    
    requestRedraw();
}

function animateNodes(targetPositions, duration = 800) {
    if (isAnimating) return;
    
    isAnimating = true;
    const startTime = performance.now();
    const startPositions = {};
    
    // Store starting positions
    for (const id in targetPositions) {
    if (nodes[id]) {
        startPositions[id] = { x: nodes[id].x, y: nodes[id].y };
    }
    }

    function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Smooth easing function (ease-out)
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    
    // Interpolate positions
    for (const id in targetPositions) {
        if (nodes[id] && startPositions[id]) {
        const start = startPositions[id];
        const target = targetPositions[id];
        
        nodes[id].x = start.x + (target.x - start.x) * easeProgress;
        nodes[id].y = start.y + (target.y - start.y) * easeProgress;
        }
    }
    
    redrawCanvas();
    
    if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
    } else {
        isAnimating = false;
        animationFrame = null;
    }
    }
    
    animationFrame = requestAnimationFrame(animate);
}

function moveOtherFamiliesAway(expandedNodeId, newChildrenPositions) {
    const newChildIds = nodes[expandedNodeId].children;
    const movements = calculatePushMovementsSync(expandedNodeId, newChildrenPositions, newChildIds);
    
    // Apply movements with smooth animation
    if (Object.keys(movements).length > 0) {
    animateNodes(movements, 1000);
    }
}

async function moveOtherFamiliesAwayAsync(expandedNodeId, newChildrenPositions) {
    const newChildIds = nodes[expandedNodeId].children;

    const movements = await calculatePushMovementsAsync(expandedNodeId, newChildrenPositions, newChildIds);
    
    // Apply movements with smooth animation
    if (Object.keys(movements).length > 0) {
    animateNodes(movements, 1000);
    }
}

function isDescendantOf(nodeId, ancestorId) {
    let current = nodes[nodeId];
    while (current && current.parent) {
    if (current.parent === ancestorId) return true;
    current = nodes[current.parent];
    }
    return false;
}

function moveNodeAndDescendants(node, deltaX, deltaY) {
    // Move the node itself
    node.x += deltaX;
    node.y += deltaY;
    
    // Recursively move all children and their descendants
    for (const childId of node.children) {
    const child = nodes[childId];
    if (child && child.visible !== false) {
        moveNodeAndDescendants(child, deltaX, deltaY);
    }
    }
}

function moveEntireFamily(rootId, deltaX, deltaY, movements) {
    const visited = new Set();
    
    function moveNodeAndChildren(nodeId) {
    if (visited.has(nodeId) || !nodes[nodeId]) return;
    visited.add(nodeId);
    
    const node = nodes[nodeId];
    if (!movements[nodeId]) { // Don't override if already moved
        movements[nodeId] = {
        x: node.x + deltaX,
        y: node.y + deltaY,
        deltaX: deltaX,
        deltaY: deltaY
        };
    }
    
    // Move all children recursively
    for (const childId of node.children) {
        moveNodeAndChildren(childId);
    }
    }
    
    moveNodeAndChildren(rootId);
}

let hoveredNode = null;
let hoverPanel = null;
let hoverTimeout = null;

// Initialize hover panel
function initHoverPanel() {
    hoverPanel = document.getElementById('hover-panel');
}

// PERFORMANCE OPTIMIZATION: Debounced hover panel with cached API calls
function showHoverPanel(node, mouseX, mouseY) {
    if (!hoverPanel) return;
    
    // Clear any existing timeout
    if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    }
    
    // Clear any existing API timeout
    if (hoverApiTimeout) {
    clearTimeout(hoverApiTimeout);
    hoverApiTimeout = null;
    }
    
    // Update panel content immediately with basic info
    document.getElementById('hover-title').textContent = node.name || 'Loading...';
    document.getElementById('hover-description').textContent = 'Loading term details...';
    document.getElementById('hover-description').className = 'loading';
    document.getElementById('hover-id').textContent = node.id;
    
    // Position the panel near the mouse
    const rect = canvas.getBoundingClientRect();
    let panelX = mouseX + 15;
    let panelY = mouseY - 10;
    
    // Keep panel within canvas bounds
    const panelWidth = 280;
    const panelHeight = 100;
    
    if (panelX + panelWidth > rect.width) {
    panelX = mouseX - panelWidth - 15;
    }
    if (panelY + panelHeight > rect.height) {
    panelY = mouseY - panelHeight + 10;
    }
    if (panelY < 0) panelY = 10;
    
    hoverPanel.style.left = panelX + 'px';
    hoverPanel.style.top = panelY + 'px';
    hoverPanel.classList.add('visible');
    
    // PERFORMANCE OPTIMIZATION: Debounced API call
    hoverApiTimeout = setTimeout(() => {
    if (hoveredNode && hoveredNode.id === node.id) {
        // Check cache first
        const cachedTerm = getCachedTerm(node.id);
        if (cachedTerm) {
        updateHoverPanelContent(node, cachedTerm);
        } else {
        // Fetch detailed term info
        fetchGOTerm(node.id).then(term => {
            if (hoveredNode && hoveredNode.id === node.id && term) {
            updateHoverPanelContent(node, term);
            }
        }).catch(error => {
            if (hoveredNode && hoveredNode.id === node.id) {
            document.getElementById('hover-description').textContent = 'Error loading term details';
            document.getElementById('hover-description').className = '';
            }
        });
        }
    }
    }, hoverApiDelay);
}

// Helper function to update hover panel content
function updateHoverPanelContent(node, term) {
    document.getElementById('hover-title').textContent = term.name || node.name;
    
    // Create a nice description using the correct schema path
    let description = '';
    if (term.definition) {
    description = term.definition.length > 120 ? 
        term.definition.substring(0, 120) + '...' : 
        term.definition;
    } else {
    description = 'No description available';
    }
    
    document.getElementById('hover-description').textContent = description;
    document.getElementById('hover-description').className = '';
}

function hideHoverPanel() {
    if (!hoverPanel) return;
    
    // Clear any pending API calls
    if (hoverApiTimeout) {
    clearTimeout(hoverApiTimeout);
    hoverApiTimeout = null;
    }
    
    hoverTimeout = setTimeout(() => {
    hoverPanel.classList.remove('visible');
    hoveredNode = null;
    }, 50); // Small delay to prevent flickering
}

// Legacy function kept for compatibility - now uses optimized version
function getHoveredNode(mouseX, mouseY) {
    return getHoveredNodeOptimized(mouseX, mouseY);
}

// Legend panel functionality
function initLegendPanel() {
    const infoIcon = document.getElementById('info-icon');
    const legendPanel = document.getElementById('legend-panel');
    const closeButton = document.getElementById('close-legend');
    
    // Show legend panel, hide info icon
    function showLegend() {
    infoIcon.style.display = 'none';
    legendPanel.classList.add('visible');
    }
    
    // Hide legend panel, show info icon
    function hideLegend() {
    legendPanel.classList.remove('visible');
    setTimeout(() => {
        infoIcon.style.display = 'flex';
    }, 150); // Small delay for smooth transition
    }
    
    // Event listeners
    infoIcon.addEventListener('click', showLegend);
    closeButton.addEventListener('click', hideLegend);
    
    // Close legend when clicking outside
    document.addEventListener('click', (e) => {
    if (legendPanel.classList.contains('visible') && 
        !legendPanel.contains(e.target) && 
        !infoIcon.contains(e.target)) {
        hideLegend();
    }
    });
}

canvas.addEventListener("click", async (e) => {
    // Click events are now handled in mouseup to distinguish from drag
    // This prevents double-triggering of toggleNode
    e.preventDefault();
});

function showTermDetails(id) {
    const node = nodes[id];
    const termInfo = document.getElementById("term-info");
    const strainList = document.getElementById("strainList");
    
    termInfo.innerHTML = `
    <h3 class="font-semibold">${node.name}</h3>
    <p class="text-sm text-gray-600">${id}</p>
    <p class="text-xs text-gray-500 mt-1">Loading strain data...</p>
    `;

    // Fetch detailed term info from backend
    fetchGOTerm(id).then(term => {
    if (term) {
        termInfo.innerHTML = `
        <h3 class="font-semibold">${term.name || node.name}</h3>
        <p class="text-sm text-gray-600">${id}</p>
        `;
    }
    }).catch(error => {
    console.error('Error loading term details:', error);
    termInfo.innerHTML += `<p class="text-red-500 text-xs">Error loading details</p>`;
    });

    // Fetch strain data from separate endpoint
    strainList.innerHTML = '<li class="text-gray-500">Loading strains...</li>';
    fetch(`${apiUrl}/go/${encodeURIComponent(id)}/mmrrc-strains`)
    .then(response => response.ok ? response.json() : [])
    .then(strains => {
        if (strains.length > 0) {
        strainList.innerHTML = strains.map((strain, index) => 
            `<li class="my-2 px-2 py-1 rounded ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'}">
            <a href="https://www.mmrrc.org/catalog/sds.php?mmrrc_id=${strain.mmrrc_id}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline block leading-tight">
                ${strain.mmrrc_id}
            </a>
            <div class="text-xs text-gray-500 leading-tight" style="font-size: 8px;">
                MMRRC ID: ${strain.mmrrc_id}
            </div>
            </li>`
        ).join('');
        } else {
        strainList.innerHTML = '<li class="text-gray-500">No linked strains found</li>';
        }
    })
    .catch(error => {
        console.error('Error loading strain data:', error);
        strainList.innerHTML = '<li class="text-red-500">Error loading strains</li>';
    });
}

// Pan the canvas
let isDragging = false;
let isDraggingNode = false;
let draggedNode = null;
let dragStartTime = 0;
let lastX, lastY;
let lastNodeX, lastNodeY; // Track last node position for delta calculation
const dragThreshold = 150; // ms to distinguish between click and drag

canvas.addEventListener("mousedown", (e) => {
    const mousePos = getMousePos(e);
    let clickedNode = null;
    
    // Check if clicking on a node first
    for (const id in nodes) {
    const node = nodes[id];
    if (node.visible === false) continue;
    
    const dx = mousePos.x - node.x;
    const dy = mousePos.y - node.y;
    if (dx * dx + dy * dy <= 40 * 40) {
        clickedNode = node;
        break;
    }
    }
    
    if (clickedNode) {
    // Prepare for potential node dragging
    draggedNode = clickedNode;
    dragStartTime = Date.now();
    lastX = e.clientX;
    lastY = e.clientY;
    lastNodeX = clickedNode.x;
    lastNodeY = clickedNode.y;
    } else {
    // Start canvas panning
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    }
});

function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
    x: (e.clientX - rect.left - panX) / zoomLevel,
    y: (e.clientY - rect.top - panY) / zoomLevel
    };
}

// PERFORMANCE OPTIMIZATION: Optimized mousemove event handler
canvas.addEventListener("mousemove", (e) => {
    // Update current mouse position for throttled hover detection
    const rect = canvas.getBoundingClientRect();
    currentMousePos.x = e.clientX - rect.left;
    currentMousePos.y = e.clientY - rect.top;
    
    // Handle canvas panning
    if (isDragging) {
    canvas.className = "infinite-canvas dragging-canvas";
    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;
    
    panX += deltaX;
    panY += deltaY;
    
    lastX = e.clientX;
    lastY = e.clientY;
    
    requestRedraw();
    return;
    }

    // Handle node dragging
    if (draggedNode && !isDraggingNode) {
    const deltaX = Math.abs(e.clientX - lastX);
    const deltaY = Math.abs(e.clientY - lastY);
    const timeDiff = Date.now() - dragStartTime;
    
    // Start dragging if mouse moved enough or held long enough
    if ((deltaX > 5 || deltaY > 5) || timeDiff > dragThreshold) {
        isDraggingNode = true;
        canvas.className = "infinite-canvas dragging-node";
        hideHoverPanel(); // Hide hover panel during drag
    }
    }

    if (isDraggingNode && draggedNode) {
    // Calculate movement delta in world coordinates
    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;
    
    const worldDeltaX = deltaX / zoomLevel;
    const worldDeltaY = deltaY / zoomLevel;
    
    // Move the dragged node and all its descendants
    moveNodeAndDescendants(draggedNode, worldDeltaX, worldDeltaY);
    
    lastX = e.clientX;
    lastY = e.clientY;
    
    requestRedraw();
    return;
    }

    // PERFORMANCE OPTIMIZATION: Throttled hover detection (only if not dragging)
    if (!isDragging && !isDraggingNode) {
    canvas.className = "infinite-canvas";
    throttledHoverCheck();
    }
});

canvas.addEventListener("mouseenter", () => {
    isMouseOverCanvas = true;
});

canvas.addEventListener("mouseleave", () => {
    isMouseOverCanvas = false;
    hideHoverPanel();
    
    // Reset drag states if mouse leaves canvas
    isDragging = false;
    isDraggingNode = false;
    draggedNode = null;
    dragStartTime = 0;
    lastNodeX = 0;
    lastNodeY = 0;
    canvas.className = "infinite-canvas";
    
    // Clean up any ongoing shrinking animations
    shrinkingNodes.clear();
    if (shrinkingAnimationId) {
    cancelAnimationFrame(shrinkingAnimationId);
    shrinkingAnimationId = null;
    }
});

canvas.addEventListener("mouseup", (e) => {
    // Check for arrow clicks FIRST, before checking node clicks
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Check for arrow clicks using SCREEN coordinates
    if (window.arrowClickAreas) {
    for (const arrowId in window.arrowClickAreas) {
        const area = window.arrowClickAreas[arrowId];
        
        if (mouseX >= area.x && mouseX <= area.x + area.width &&
            mouseY >= area.y && mouseY <= area.y + area.height) {
        // Click on arrow - navigate to page
        console.log('Arrow clicked:', area.direction, 'for node:', area.nodeId);
        console.log('Click coordinates:', mouseX, mouseY);
        console.log('Arrow area:', area);
        navigateToPage(area.nodeId, area.direction);
        
        // Reset drag states and exit
        isDragging = false;
        isDraggingNode = false;
        draggedNode = null;
        dragStartTime = 0;
        lastNodeX = 0;
        lastNodeY = 0;
        canvas.className = "infinite-canvas";
        return;
        }
    }
    }
    
    // Handle node click vs drag (only if no arrow was clicked)
    if (draggedNode && !isDraggingNode) {
    // Regular node click - trigger toggle
    const timeDiff = Date.now() - dragStartTime;
    if (timeDiff < dragThreshold) {
        toggleNode(draggedNode.id);
        showTermDetails(draggedNode.id);
    }
    }
    
    // Reset all drag states
    isDragging = false;
    isDraggingNode = false;
    draggedNode = null;
    dragStartTime = 0;
    lastNodeX = 0;
    lastNodeY = 0;
    
    // Reset cursor
    canvas.className = "infinite-canvas";
});

// Zoom functionality
canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Calculate zoom
    const zoomDelta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
    const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel + zoomDelta));
    
    if (newZoom !== zoomLevel) {
    // Zoom towards mouse position
    const mouseWorldX = (mouseX - panX) / zoomLevel;
    const mouseWorldY = (mouseY - panY) / zoomLevel;
    
    zoomLevel = newZoom;
    
    // Adjust pan to keep mouse position stable
    panX = mouseX - (mouseWorldX * zoomLevel);
    panY = mouseY - (mouseWorldY * zoomLevel);
    
    requestRedraw();
    }
});

async function init() {
    console.log("Initializing optimized mind map...");
    
    // Initialize web worker for layout calculations
    try {
    initLayoutWorker();
    console.log("Web worker initialized for layout calculations");
    } catch (error) {
    console.warn("Web worker not available, falling back to main thread calculations:", error);
    }
    
    // Initialize hover panel
    initHoverPanel();
    
    // Initialize legend panel
    initLegendPanel();
    
    // Position root terms with more spacing to avoid initial overlap
    const positions = [
    { x: 220, y: 150 },   // Top-left
    { x: 670, y: 200 },   // Top-right  
    { x: 420, y: 360 }    // Bottom-center
    ];

    for (let i = 0; i < ROOT_TERMS.length; i++) {
    const rootId = ROOT_TERMS[i];
    const term = await fetchGOTerm(rootId);
    
    if (term) {
        const node = {
        id: rootId,
        name: term.name || rootId,
        x: positions[i].x,
        y: positions[i].y,
        parent: null,
        relation_type: null,
        children: [],
        childrenLoaded: false,
        visible: true,
        hasChildren: true,
        currentPage: 1,
        totalPages: 1,
        allChildren: [],
        childrenData: [] // Store raw children data for pagination
        };
        
        nodes[rootId] = node;
        console.log(`Added root node: ${term.name}`);
    }
    }
    
    // Initial draw
    redrawCanvas();
    console.log("Optimized mind map initialization complete");
}

// Cleanup function
function cleanup() {
    if (layoutWorker) {
    layoutWorker.terminate();
    layoutWorker = null;
    console.log("Web worker terminated");
    }
    
    // Clear all timeouts
    if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
    }
    
    if (hoverApiTimeout) {
    clearTimeout(hoverApiTimeout);
    hoverApiTimeout = null;
    }
    
    // Clear animation frames
    if (hoverUpdateFrame) {
    cancelAnimationFrame(hoverUpdateFrame);
    hoverUpdateFrame = null;
    }
    
    if (shrinkingAnimationId) {
    cancelAnimationFrame(shrinkingAnimationId);
    shrinkingAnimationId = null;
    }
    
    if (rippleAnimationId) {
    cancelAnimationFrame(rippleAnimationId);
    rippleAnimationId = null;
    }
    
    // Clear caches
    termCache.clear();
    visibleNodesByRegion.clear();
    
    console.log("Cleanup complete");
}

// Handle page unload
window.addEventListener('beforeunload', cleanup);

// Start when page loads
document.addEventListener('DOMContentLoaded', init);