// netlify/functions/simulate-profits.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e);
}
const db = admin.firestore();

// --- CONFIGURATION ---
const PEAK_HOURS_START = 16;
const PEAK_HOURS_END = 22;
const PEAK_HOUR_MULTIPLIER = 1.25;

// Charging Speeds (in kW)
const SPEEDS = {
    'Standard Port': 50,       // Simulating a 50kW DC Charger (40-60 mins avg)
    'High-Traffic Pro Port': 150 // Simulating a 150kW Supercharger (15-30 mins avg)
};

const PACKAGES = {
  'Standard Port': { sessions: { slow: { chance: 0.2, min: 7.00, max: 11.00 }, standard: { chance: 0.6, min: 11.00, max: 16.00 }, busy: { chance: 0.2, min: 16.00, max: 22.00 }}},
  'High-Traffic Pro Port': { sessions: { slow: { chance: 0.2, min: 12.00, max: 18.00 }, standard: { chance: 0.6, min: 18.00, max: 24.00 }, busy: { chance: 0.2, min: 24.00, max: 32.00 }}}
};

// --- VEHICLE DATABASE (Weighted) ---
// Weight 5 = Extremely Common, 1 = Rare/Exotic
const VEHICLES = [
    // --- THE BIG SELLERS (Weight 5) ---
    { model: "Tesla Model Y", weight: 5 },
    { model: "Tesla Model 3", weight: 5 },
    { model: "Toyota bZ4X", weight: 5 },
    
    // --- COMMON (Weight 4) ---
    { model: "Tesla Model S", weight: 4 },
    { model: "Tesla Model X", weight: 4 },
    { model: "Ford Mustang Mach-E", weight: 4 },
    { model: "Volkswagen ID.4", weight: 4 },
    { model: "Hyundai Ioniq 5", weight: 4 },
    { model: "Kia EV6", weight: 4 },
    { model: "Chevrolet Bolt EV", weight: 4 },
    { model: "Nissan Leaf", weight: 4 },
    
    // --- REGULAR TRAFFIC (Weight 3) ---
    { model: "Ford F-150 Lightning", weight: 3 },
    { model: "Rivian R1T", weight: 3 },
    { model: "Rivian R1S", weight: 3 },
    { model: "BMW i4", weight: 3 },
    { model: "Audi Q4 e-tron", weight: 3 },
    { model: "Polestar 2", weight: 3 },
    { model: "Volvo XC40 Recharge", weight: 3 },
    { model: "Hyundai Ioniq 6", weight: 3 },
    { model: "Kia Niro EV", weight: 3 },
    { model: "Chevrolet Blazer EV", weight: 3 },
    { model: "Cadillac Lyriq", weight: 3 },
    { model: "Nissan Ariya", weight: 3 },
    { model: "Tesla Cybertruck", weight: 3 }, // High hype factor

    // --- LUXURY / PREMIUM (Weight 2) ---
    { model: "Porsche Taycan", weight: 2 },
    { model: "Lucid Air", weight: 2 },
    { model: "Mercedes EQS Sedan", weight: 2 },
    { model: "Mercedes EQE SUV", weight: 2 },
    { model: "BMW iX", weight: 2 },
    { model: "Audi e-tron GT", weight: 2 },
    { model: "Genesis GV60", weight: 2 },
    { model: "Lexus RZ 450e", weight: 2 },
    { model: "Volvo EX90", weight: 2 },
    { model: "Jaguar I-PACE", weight: 2 },
    
    // --- RARE / SPECIALTY / NEW (Weight 1) ---
    { model: "GMC Hummer EV", weight: 1 },
    { model: "Chevrolet Silverado EV", weight: 1 },
    { model: "Fisker Ocean", weight: 1 },
    { model: "Lotus Eletre", weight: 1 },
    { model: "Rolls-Royce Spectre", weight: 1 },
    { model: "Rimac Nevera", weight: 1 }, // Very rare sighting!
    { model: "Honda Prologue", weight: 1 },
    { model: "Acura ZDX", weight: 1 }
];

const REGIONAL_PRICES_PER_KWH = {
    'United States': 0.45, 'Canada': 0.38, 'Mexico': 0.30, 'Puerto Rico': 0.42,
    'Germany': 0.65, 'United Kingdom': 0.58, 'France': 0.52, 'Spain': 0.55, 'Italy': 0.60,
    'Australia': 0.40, 'New Zealand': 0.35, 'Japan': 0.48, 'China': 0.25,
};
const DEFAULT_PRICE_PER_KWH = 0.45; 
const CO2_OFFSET_FACTOR_KG_PER_KWH = 0.4; 

// --- HELPER FUNCTIONS ---
const getRandomProfit = (config) => {
  const rand = Math.random(); let cumulativeChance = 0; const sessionTypes = ['slow', 'standard', 'busy'];
  for (const type of sessionTypes) {
    cumulativeChance += config.sessions[type].chance;
    if (rand < cumulativeChance) { const { min, max } = config.sessions[type]; return parseFloat((Math.random() * (max - min) + min).toFixed(2)); }
  }
  const { min, max } = config.sessions.standard; return parseFloat((Math.random() * (max - min) + min).toFixed(2));
};

// Weighted Random Selection for Cars
const getRandomVehicle = () => {
    const totalWeight = VEHICLES.reduce((sum, v) => sum + v.weight, 0);
    let random = Math.random() * totalWeight;
    for (const car of VEHICLES) {
        if (random < car.weight) return car.model;
        random -= car.weight;
    }
    return "Tesla Model Y"; // Fallback
};

const getDynamicDescription = (portData, portId) => `Earning from ${portData.locationName || 'Unknown Location'} (${portData.portIdentifier || `#${portId.substring(0,4)}`})`;

// --- MAIN HANDLER ---
exports.handler = async function(event, context) {
  console.log("Starting profit simulation with Session Details & Realism...");
  
  // Get Current Time info for Utilization math
  const now = new Date();
  const currentHour = now.getUTCHours();
  const isPeakHour = currentHour >= PEAK_HOURS_START && currentHour <= PEAK_HOURS_END;

  // Calculate total minutes passed in the current month so far (for utilization math)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const minutesSinceMonthStart = (now - startOfMonth) / (1000 * 60);

  try {
    const portsSnapshot = await db.collectionGroup('ports').where('status', '==', 'Active').get();
    if (portsSnapshot.empty) { return { statusCode: 200, body: "No active ports found." }; }

    const promises = [];
    for (const portDoc of portsSnapshot.docs) {
      const portData = portDoc.data();
      const packageConfig = PACKAGES[portData.package];
      if (!packageConfig) continue;

      // --- REALISM TWEAK #1: IDLE CHECK ---
      // 15% chance that this port had no customers this hour
      // This prevents every single port from generating money at the same time.
      if (Math.random() < 0.15) {
        console.log(`Port ${portDoc.id} is idle this hour.`);
        continue; 
      }

      // --- 1. Profit Calculation ---
      let profit = getRandomProfit(packageConfig);
      if (isPeakHour) { profit = parseFloat((profit * PEAK_HOUR_MULTIPLIER).toFixed(2)); }
      
      // --- 2. Physics Calculation (Energy) ---
      const pricePerKwh = REGIONAL_PRICES_PER_KWH[portData.region] || DEFAULT_PRICE_PER_KWH;
      const kwhDelivered = parseFloat((profit / pricePerKwh).toFixed(2));
      const co2Offset = parseFloat((kwhDelivered * CO2_OFFSET_FACTOR_KG_PER_KWH).toFixed(2));
      
      // --- 3. Physics Calculation (Time & Range) ---
      const chargerSpeed = SPEEDS[portData.package] || 50; // Default to 50kW if unknown
      // Add slight randomness to speed (+/- 10%) for realism
      const actualSpeed = chargerSpeed * (0.9 + Math.random() * 0.2); 
      
      const durationHours = kwhDelivered / actualSpeed;
      const durationMinutes = Math.round(durationHours * 60);
      const milesAdded = Math.round(kwhDelivered * 3.5); // approx 3.5 mi/kWh efficiency
      
      const vehicle = getRandomVehicle();

      // --- REALISM TWEAK #2: BACKDATED TIMESTAMP ---
      // Instead of forcing everything to be "Now", we pick a random minute
      // within the previous 60 minutes.
      const randomMinutesAgo = Math.floor(Math.random() * 60); // 0 to 59 minutes
      const backdatedTimestamp = new Date(now.getTime() - (randomMinutesAgo * 60 * 1000));

      // --- 4. UTILIZATION CALCULATION ---
      const currentMonthlyMinutes = portData.monthlyDurationMinutes || 0;
      const newMonthlyMinutes = currentMonthlyMinutes + durationMinutes;
      
      let utilization = 0;
      if (minutesSinceMonthStart > 0) {
          utilization = (newMonthlyMinutes / minutesSinceMonthStart) * 100;
          if (utilization > 100) utilization = 100; // Cap at 100%
      }
      utilization = parseFloat(utilization.toFixed(1));

      const userId = portDoc.ref.parent.parent.id;
      const portId = portDoc.id;

      const batch = db.batch();
      const userRef = db.collection('users').doc(userId);

      // --- 5. Update User Totals ---
      batch.update(userRef, {
        availableBalance: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit),
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit),
        monthlyKwhDelivered: admin.firestore.FieldValue.increment(kwhDelivered),
        monthlySessions: admin.firestore.FieldValue.increment(1),
        monthlyCo2Offset: admin.firestore.FieldValue.increment(co2Offset),
      });

      // --- 6. Update Port Totals ---
      batch.update(userRef.collection('ports').doc(portId), {
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit),
        monthlyDurationMinutes: admin.firestore.FieldValue.increment(durationMinutes),
        utilization: utilization
      });

      // --- 7. Create Detailed Activity Log (WITH BACKDATED TIME) ---
      const activityRef = userRef.collection('activity').doc();
      batch.set(activityRef, {
        type: 'earning', 
        amount: profit, 
        description: getDynamicDescription(portData, portId),
        // Use the randomized time instead of serverTimestamp()
        timestamp: backdatedTimestamp, 
        portId: portId,
        sessionDetails: {
            vehicle: vehicle,
            kwh: kwhDelivered,
            durationMins: durationMinutes,
            milesAdded: milesAdded
        }
      });

      promises.push(batch.commit());
    }

    await Promise.all(promises);
    return { statusCode: 200, body: `Simulated ${promises.length} sessions with randomized timings.` };

  } catch (error) {
    console.error("Error:", error);
    return { statusCode: 500, body: "Error." };
  }
};