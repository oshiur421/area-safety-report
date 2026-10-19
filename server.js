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
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error loading data.json, using defaults:', err.message);
    return { safetyScore: 50, unsafeRoads: [], incidents: [] };
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
      description: incident.description || ''
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

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SafeZone server running on http://localhost:${PORT}`);
});
