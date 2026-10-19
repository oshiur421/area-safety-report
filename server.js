const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const DATA_FILE = path.join(__dirname, 'data.json');

// Pre-defined key areas of Dhaka for consistent reporting & tracking
const KNOWN_AREAS = [
  'Dhanmondi',
  'Mirpur',
  'Sadarghat',
  'Uttara',
  'Farmgate',
  'Gulshan',
  'Banani',
  'Mohakhali',
  'Motijheel',
  'Mohammadpur',
  'Shahbagh'
];

function extractArea(locationStr) {
  if (!locationStr || typeof locationStr !== 'string') return 'General Dhaka';
  const clean = locationStr.trim();
  for (const area of KNOWN_AREAS) {
    const reg = new RegExp('\\b' + area + '\\b', 'i');
    if (reg.test(clean)) {
      return area;
    }
  }
  // Fallback to substring extraction before or after comma
  const parts = clean.split(/[,–-]/);
  if (parts.length > 1) {
    const candidate = parts[parts.length - 1].trim();
    if (candidate.length > 2 && candidate.length < 30) return candidate;
  }
  return clean.length > 25 ? clean.slice(0, 25) + '…' : clean;
}

function calculateSafetyScores(data) {
  const incidents = Array.isArray(data.incidents) ? data.incidents : [];

  let totalCritical = 0;
  let totalModerate = 0;

  // Initialize known areas so they are always represented in dashboard
  const areaGroups = {};
  KNOWN_AREAS.slice(0, 6).forEach((area) => {
    areaGroups[area] = {
      areaName: area,
      criticalCount: 0,
      moderateCount: 0,
      totalThreats: 0,
      score: 100
    };
  });

  incidents.forEach((inc) => {
    const isCritical = (inc.severity || '').toLowerCase() === 'critical';
    if (isCritical) {
      totalCritical++;
    } else {
      totalModerate++;
    }

    const area = extractArea(inc.areaName || inc.location || inc.title);
    if (!areaGroups[area]) {
      areaGroups[area] = {
        areaName: area,
        criticalCount: 0,
        moderateCount: 0,
        totalThreats: 0,
        score: 100
      };
    }

    areaGroups[area].totalThreats++;
    if (isCritical) {
      areaGroups[area].criticalCount++;
    } else {
      areaGroups[area].moderateCount++;
    }
  });

  // Calculate scores per area: 100% - (15% * critical) - (7% * moderate)
  const areaBreakdown = Object.values(areaGroups).map((item) => {
    const rawScore = 100 - (item.criticalCount * 15) - (item.moderateCount * 7);
    const score = Math.max(0, Math.min(100, rawScore));
    let status = 'Safe';
    if (score < 40) status = 'High Danger';
    else if (score < 70) status = 'Moderate Risk';

    return {
      areaName: item.areaName,
      totalThreats: item.totalThreats,
      criticalCount: item.criticalCount,
      moderateCount: item.moderateCount,
      score: score,
      status: status
    };
  });

  // Sort: areas with active threats first, then by lowest score (highest danger)
  areaBreakdown.sort((a, b) => b.totalThreats - a.totalThreats || a.score - b.score);

  // Overall city score calculation
  const overallRaw = 100 - (totalCritical * 15) - (totalModerate * 7);
  const overallScore = Math.max(0, Math.min(100, overallRaw));

  return {
    safetyScore: overallScore,
    totalThreats: incidents.length,
    totalCritical: totalCritical,
    totalModerate: totalModerate,
    areaScores: areaBreakdown
  };
}

// --- Data Layer ---
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const loaded = {
      safetyScore: 100,
      unsafeRoads: Array.isArray(parsed.unsafeRoads) ? parsed.unsafeRoads : [],
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      userReports: Array.isArray(parsed.userReports) ? parsed.userReports : []
    };
    const stats = calculateSafetyScores(loaded);
    Object.assign(loaded, stats);
    return loaded;
  } catch (err) {
    console.error('Error loading data.json, using defaults:', err.message);
    const defaults = { safetyScore: 100, unsafeRoads: [], incidents: [], userReports: [] };
    const stats = calculateSafetyScores(defaults);
    Object.assign(defaults, stats);
    return defaults;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

let safetyData = loadData();

function refreshAndSaveSafetyScores() {
  const stats = calculateSafetyScores(safetyData);
  safetyData.safetyScore = stats.safetyScore;
  safetyData.totalThreats = stats.totalThreats;
  safetyData.totalCritical = stats.totalCritical;
  safetyData.totalModerate = stats.totalModerate;
  safetyData.areaScores = stats.areaScores;
  saveData(safetyData);
  console.log(`Auto-calculated Safety Score: ${safetyData.safetyScore}% across ${safetyData.totalThreats} active threats (${safetyData.totalCritical} critical, ${safetyData.totalModerate} moderate)`);
}

// Ensure initial save has fresh auto-calculated values
refreshAndSaveSafetyScores();

// --- Express ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send full state to newly connected client
  socket.emit('init-safety-data', safetyData);

  // Admin: add unsafe road
  socket.on('add-unsafe-road', (road) => {
    if (!road || !road.id || !road.coordinates || road.coordinates.length < 2) {
      return socket.emit('error-msg', 'Invalid road data. Draw at least 2 points.');
    }
    safetyData.unsafeRoads.push({
      id: road.id,
      roadName: road.roadName || 'Unnamed Road',
      riskLevel: road.riskLevel || 'Moderate Risk',
      coordinates: road.coordinates
    });
    saveData(safetyData);
    io.emit('safety-data-updated', safetyData);
    console.log(`Unsafe road added: ${road.roadName}`);
  });

  // Admin: delete unsafe road
  socket.on('delete-unsafe-road', (id) => {
    safetyData.unsafeRoads = safetyData.unsafeRoads.filter((r) => r.id !== id);
    saveData(safetyData);
    io.emit('safety-data-updated', safetyData);
    console.log(`Unsafe road deleted: ${id}`);
  });

  // Admin: add incident (auto-recalculates score)
  socket.on('add-incident', (incident) => {
    if (!incident || !incident.id || !incident.title) {
      return socket.emit('error-msg', 'Invalid incident data.');
    }
    safetyData.incidents.push({
      id: incident.id,
      title: incident.title,
      areaName: incident.areaName || '',
      date: incident.date || new Date().toISOString().slice(0, 10),
      severity: incident.severity || 'Warning',
      description: incident.description || '',
      coordinates: incident.coordinates || null
    });
    refreshAndSaveSafetyScores();
    io.emit('safety-data-updated', safetyData);
    console.log(`Incident added: ${incident.title}`);
  });

  // Admin: delete incident (auto-recalculates score)
  socket.on('delete-incident', (id) => {
    safetyData.incidents = safetyData.incidents.filter((i) => i.id !== id);
    refreshAndSaveSafetyScores();
    io.emit('safety-data-updated', safetyData);
    console.log(`Incident deleted: ${id}`);
  });

  // --- Crowdsourced User Reports ---

  // User: submit a crowdsourced safety report
  socket.on('submit-user-report', (report) => {
    if (!report || !report.location || !report.description) {
      return socket.emit('error-msg', 'Please provide at least a location and description.');
    }

    const newReport = {
      id: 'rep-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      reporterName: report.reporterName && report.reporterName.trim() ? report.reporterName.trim() : 'Anonymous',
      location: report.location.trim(),
      issueType: report.issueType || 'Other',
      lat: report.lat !== undefined && report.lat !== '' && !isNaN(report.lat) ? parseFloat(report.lat) : null,
      lng: report.lng !== undefined && report.lng !== '' && !isNaN(report.lng) ? parseFloat(report.lng) : null,
      description: report.description.trim(),
      severity: report.severity === 'Critical' ? 'Critical' : 'Moderate',
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    if (!Array.isArray(safetyData.userReports)) {
      safetyData.userReports = [];
    }

    safetyData.userReports.unshift(newReport);
    saveData(safetyData);

    io.emit('safety-data-updated', safetyData);
    socket.emit('report-submission-success', {
      id: newReport.id,
      message: 'Report submitted successfully! Thank you for helping keep the community safe.'
    });
    console.log(`New crowdsourced report submitted: [${newReport.issueType}] ${newReport.location} by ${newReport.reporterName}`);
  });

  // Admin: approve user report and promote to official incidents / map (auto-recalculates score)
  socket.on('approve-user-report', (targetId) => {
    const id = typeof targetId === 'object' && targetId !== null ? targetId.id : targetId;
    if (!Array.isArray(safetyData.userReports)) safetyData.userReports = [];

    const index = safetyData.userReports.findIndex((r) => r.id === id);
    if (index === -1) {
      return socket.emit('error-msg', 'Report not found or already processed.');
    }

    const report = safetyData.userReports.splice(index, 1)[0];

    const incidentId = 'inc-' + Date.now();
    const approvedIncident = {
      id: incidentId,
      title: `[${report.issueType}] ${report.location}`,
      areaName: report.location,
      date: report.timestamp ? report.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10),
      severity: report.severity === 'Critical' ? 'Critical' : 'Warning',
      description: `${report.description} (Reported by: ${report.reporterName || 'Anonymous'})`,
      coordinates: (report.lat !== null && report.lng !== null) ? [report.lat, report.lng] : null,
      issueType: report.issueType
    };

    safetyData.incidents.unshift(approvedIncident);
    refreshAndSaveSafetyScores();

    io.emit('safety-data-updated', safetyData);
    console.log(`Crowdsourced report ${id} approved and added as incident ${incidentId}`);
  });

  // Admin: reject or delete user report
  socket.on('reject-user-report', (targetId) => {
    const id = typeof targetId === 'object' && targetId !== null ? targetId.id : targetId;
    if (!Array.isArray(safetyData.userReports)) safetyData.userReports = [];

    safetyData.userReports = safetyData.userReports.filter((r) => r.id !== id);
    saveData(safetyData);

    io.emit('safety-data-updated', safetyData);
    console.log(`Crowdsourced report ${id} rejected/deleted`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SafeZone server running on http://localhost:${PORT}`);
});
