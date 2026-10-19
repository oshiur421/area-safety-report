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

// --- Data Layer ---
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      safetyScore: typeof parsed.safetyScore === 'number' ? parsed.safetyScore : 50,
      unsafeRoads: Array.isArray(parsed.unsafeRoads) ? parsed.unsafeRoads : [],
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      userReports: Array.isArray(parsed.userReports) ? parsed.userReports : []
    };
  } catch (err) {
    console.error('Error loading data.json, using defaults:', err.message);
    return { safetyScore: 50, unsafeRoads: [], incidents: [], userReports: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

let safetyData = loadData();

// --- Express ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send full state to newly connected client
  socket.emit('init-safety-data', safetyData);

  // Admin: update safety score
  socket.on('update-safety-score', (score) => {
    const parsed = Math.min(100, Math.max(0, parseInt(score, 10) || 0));
    safetyData.safetyScore = parsed;
    saveData(safetyData);
    io.emit('safety-data-updated', safetyData);
    console.log(`Safety score updated to ${parsed}%`);
  });

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

  // Admin: add incident
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
    saveData(safetyData);
    io.emit('safety-data-updated', safetyData);
    console.log(`Incident added: ${incident.title}`);
  });

  // Admin: delete incident
  socket.on('delete-incident', (id) => {
    safetyData.incidents = safetyData.incidents.filter((i) => i.id !== id);
    saveData(safetyData);
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

  // Admin: approve user report and promote to official incidents / map
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
    saveData(safetyData);

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
