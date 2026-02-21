import { useEffect, useState, useRef } from 'react';
import { AlertCircle, Activity, ShieldCheck, Clock, MapPin } from 'lucide-react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
if (MAPBOX_TOKEN) {
    mapboxgl.accessToken = MAPBOX_TOKEN;
} else {
    // Provide a dummy token to prevent hard crashes if user forgot .env
    mapboxgl.accessToken = 'pk.eyJ1IjoiZHVtbXkiLCJhIjoiZHVtbXkifQ.dummy';
}

interface Telemetry {
    sessionId: string;
    latitude: number;
    longitude: number;
    speed: number;
    accelerationMagnitude: number;
    timestamp: string;
}

interface RiskUpdate {
    sessionId: string;
    riskScore: number;
    basePoints: number;
    timeMultiplier: number;
    state: 'NORMAL' | 'WARNING' | 'ESCALATION' | 'DANGER';
    reasons: string[];
    escalationTimer?: number;
    evaluatedAt: string;
}

export default function AegisDashboard() {
    const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
    const [risk, setRisk] = useState<RiskUpdate | null>(null);
    const [timeRemaining, setTimeRemaining] = useState(20);
    const [eventLog, setEventLog] = useState<{ time: string; msg: string; type: string }[]>([]);
    const ws = useRef<WebSocket | null>(null);

    // Mapbox variables
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const markerRef = useRef<mapboxgl.Marker | null>(null);

    useEffect(() => {
        let isCleaningUp = false;

        const wsUrl = `ws://${window.location.hostname}:8080/ws`;
        const socket = new WebSocket(wsUrl);
        ws.current = socket;

        socket.onopen = () => {
            if (!isCleaningUp) {
                addLog('System connected to Aegis Telemetry Gateway', 'info');
            }
        };

        socket.onmessage = (event: MessageEvent) => {
            if (isCleaningUp) return;

            // Gorilla WebSocket may concatenate multiple messages separated by \n into one frame buffer
            const messages = typeof event.data === 'string' ? event.data.split('\n') : [event.data];

            messages.forEach((msg) => {
                if (!msg || msg.trim() === '') return;

                console.log("Raw WS Message:", msg);

                try {
                    const data = JSON.parse(msg);
                    console.log("Parsed JSON:", data);

                    if ('accelerationMagnitude' in data) {
                        setTelemetry(data);
                    } else if ('riskScore' in data) {
                        setRisk((prevRisk) => {
                            const newRisk = { ...data } as RiskUpdate;

                            // Log state transitions
                            if (newRisk.state === 'DANGER' && prevRisk?.state !== 'DANGER') {
                                addLog(`CRITICAL: No response from user. Initiating Emergency Protocols!`, 'error');
                            } else if (newRisk.state === 'WARNING' && prevRisk?.state !== 'WARNING') {
                                addLog(`System detecting anomalies. Requesting safety confirmation (20s timeout)...`, 'warning');
                            }

                            // Update time remaining integer straight from backend
                            if (newRisk.state === 'WARNING' && newRisk.escalationTimer !== undefined) {
                                setTimeRemaining(newRisk.escalationTimer);
                            }

                            return newRisk;
                        });

                        if (data.reasons && data.reasons.length > 0) {
                            data.reasons.forEach((reason: string) => {
                                // Add check so we don't spam the same reason every 2s
                                setEventLog((prevLog) => {
                                    if (prevLog[0] && prevLog[0].msg.includes(reason)) {
                                        return prevLog;
                                    }
                                    const time = new Date().toLocaleTimeString();
                                    return [{ time, msg: `Alert: ${reason} for user ${data.sessionId}`, type: 'warning' }, ...prevLog].slice(0, 50);
                                });
                            });
                        }
                    }
                } catch (err) {
                    addLog(`Gateway Message: ${msg}`, 'message');
                }
            });
        };

        socket.onclose = () => {
            if (!isCleaningUp) {
                addLog('Connection lost. Please refresh or check server.', 'error');
            }
        };

        return () => {
            isCleaningUp = true;
            socket.close();
        };
    }, []);

    // Initialize map
    useEffect(() => {
        if (!mapContainerRef.current) return;

        try {
            mapRef.current = new mapboxgl.Map({
                container: mapContainerRef.current,
                style: 'mapbox://styles/mapbox/light-v11',
                center: [-122.4194, 37.7749],
                zoom: 15,
            });

            // Add a single DOM element for the marker to style dynamically
            const el = document.createElement('div');
            el.className = 'w-4 h-4 rounded-full border-2 border-white shadow-md bg-zinc-900';

            markerRef.current = new mapboxgl.Marker(el)
                .setLngLat([-122.4194, 37.7749])
                .addTo(mapRef.current);
        } catch (err) {
            console.error("Mapbox failed to initialize. Token may be missing.", err);
        }

        return () => {
            if (mapRef.current) {
                mapRef.current.remove();
            }
        };
    }, []);

    // Handle map updates when telemetry or risk changes
    useEffect(() => {
        if (!mapRef.current || !markerRef.current || !telemetry) return;

        // Animate marker to new position
        markerRef.current.setLngLat([telemetry.longitude, telemetry.latitude]);

        // Pan the map smoothly to keep marker centered
        mapRef.current.easeTo({
            center: [telemetry.longitude, telemetry.latitude],
            duration: 1000
        });

        // Update marker styles based on risk state
        const el = markerRef.current.getElement();

        if (risk?.state === 'DANGER' || risk?.state === 'ESCALATION') {
            el.className = 'w-4 h-4 rounded-full border-2 border-white shadow-md bg-red-500 animate-pulse';
            el.style.boxShadow = '0 0 0 8px rgba(239, 68, 68, 0.3)'; // Ping effect approximation
        } else if (risk?.state === 'WARNING') {
            el.className = 'w-4 h-4 rounded-full border-2 border-white shadow-md bg-amber-500';
            el.style.boxShadow = '0 0 0 6px rgba(245, 158, 11, 0.3)';
        } else {
            el.className = 'w-4 h-4 rounded-full border-2 border-white shadow-md bg-zinc-900';
            el.style.boxShadow = 'none';
        }

    }, [telemetry, risk]);

    const addLog = (msg: string, type: string) => {
        const time = new Date().toLocaleTimeString();
        setEventLog((prev: { time: string; msg: string; type: string }[]) => [{ time, msg, type }, ...prev].slice(0, 50));
    };

    const getStateColor = (state?: string) => {
        switch (state) {
            case 'NORMAL': return 'text-zinc-500 bg-zinc-100 border-zinc-200';
            case 'WARNING': return 'text-amber-600 bg-amber-50 border-amber-200';
            case 'ESCALATION':
            case 'DANGER': return 'text-red-100 bg-red-600 border-red-700 animate-pulse shadow-md shadow-red-500/50';
            default: return 'text-zinc-400 bg-zinc-50 border-zinc-200';
        }
    };

    const getGlobalBgClass = () => {
        if (!risk) return 'bg-zinc-50';
        if (risk.state === 'DANGER') return 'bg-red-600 animate-pulse'; // Extremely Bright Red
        if (risk.state === 'ESCALATION') return 'bg-red-500/20 animate-pulse';
        if (risk.state === 'WARNING') return 'bg-yellow-400/40 animate-pulse'; // Bright Yellow
        return 'bg-zinc-50';
    };

    return (
        <div className={`min-h-screen font-sans text-zinc-950 flex flex-col transition-colors duration-500 ${getGlobalBgClass()}`}>
            {/* Header */}
            <header className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
                <div className="flex items-center gap-2">
                    <ShieldCheck className="w-6 h-6 text-zinc-900" />
                    <h1 className="text-xl font-bold tracking-tight">Aegis Dashboard</h1>
                </div>
                <div className="flex items-center gap-4 text-sm font-medium">
                    <span className="flex items-center gap-1.5 text-zinc-600 px-3 py-1 bg-zinc-100 rounded-md">
                        <Activity className="w-4 h-4" /> Live Streaming
                    </span>
                </div>
            </header>

            {/* Main Grid */}
            <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Left Col: Map */}
                <section className="col-span-1 lg:col-span-2 flex flex-col bg-white rounded-xl border border-zinc-200 overflow-hidden shadow-sm h-[600px] lg:h-auto relative">
                    <div className="p-4 border-b border-zinc-200 bg-zinc-50 flex justify-between items-center">
                        <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-zinc-500" /> Live Tracking
                        </h2>
                        {telemetry && (
                            <div className="text-xs text-zinc-500 font-mono">
                                {telemetry.latitude.toFixed(5)}, {telemetry.longitude.toFixed(5)}
                            </div>
                        )}
                    </div>
                    <div className="flex-1 relative w-full h-full bg-zinc-100 overflow-hidden">
                        {/* Map Container - fills the space designated for it */}
                        <div ref={mapContainerRef} className="absolute inset-0 w-full h-full" />
                    </div>
                </section>

                {/* Right Col: Stats & Logs */}
                <section className="flex flex-col gap-6">

                    {/* Risk Card */}
                    <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-6">
                        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">Risk Evaluation</h2>

                        <div className="flex items-end justify-between mb-6">
                            <div>
                                <p className="text-5xl font-bold tracking-tighter text-zinc-900">
                                    {risk ? risk.riskScore.toFixed(0) : '0'}
                                </p>
                                <p className="text-sm text-zinc-500 mt-1">/ 100 Risk Score</p>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                                <div className={`px-3 py-1.5 rounded-md border text-xs font-bold tracking-wide uppercase ${getStateColor(risk?.state)}`}>
                                    {risk?.state || 'Awaiting Data'}
                                </div>
                                {risk?.state === 'WARNING' && (
                                    <div className="text-xs font-bold text-amber-600 bg-amber-100 px-2 py-1 rounded animate-pulse">
                                        Escalating in: {timeRemaining}s
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4">
                            <div>
                                <p className="text-xs text-zinc-500 mb-1 flex items-center gap-1"><Activity className="w-3 h-3" /> Base Points</p>
                                <p className="text-lg font-semibold text-zinc-900">{risk ? risk.basePoints : '0'}</p>
                            </div>
                            <div>
                                <p className="text-xs text-zinc-500 mb-1 flex items-center gap-1"><Clock className="w-3 h-3" /> Time Multiplier</p>
                                <p className="text-lg font-semibold text-zinc-900">{risk ? `${risk.timeMultiplier.toFixed(1)}x` : '-'}</p>
                            </div>
                        </div>
                        {telemetry && (
                            <div className="grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 mt-4">
                                <div>
                                    <p className="text-xs text-zinc-500 mb-1">Speed</p>
                                    <p className="text-sm font-medium text-zinc-900">{telemetry.speed.toFixed(2)} m/s</p>
                                </div>
                                <div>
                                    <p className="text-xs text-zinc-500 mb-1">Accel Mag</p>
                                    <p className="text-sm font-medium text-zinc-900">{telemetry.accelerationMagnitude.toFixed(2)} Gs</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Event Log Stream */}
                    <div className="bg-white rounded-xl border border-zinc-200 shadow-sm flex-1 flex flex-col overflow-hidden max-h-[400px]">
                        <div className="p-4 border-b border-zinc-200 bg-zinc-50 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-zinc-500" />
                            <h2 className="text-sm font-semibold text-zinc-800">Live Event Log</h2>
                        </div>

                        <div className="p-4 flex-1 overflow-y-auto space-y-3 bg-zinc-50/50">
                            {eventLog.length === 0 ? (
                                <p className="text-sm text-zinc-400 text-center py-8">Waiting for telemetry events...</p>
                            ) : (
                                eventLog.map((log: { time: string, msg: string, type: string }, i: number) => (
                                    <div key={i} className="flex gap-3 text-sm">
                                        <span className="text-xs text-zinc-400 font-mono whitespace-nowrap mt-0.5">{log.time}</span>
                                        <p className={`flex-1 ${log.type === 'error' ? 'text-red-600 font-medium' :
                                            log.type === 'warning' ? 'text-amber-600' :
                                                log.type === 'message' ? 'text-blue-600 italic' :
                                                    'text-zinc-600'
                                            }`}>
                                            {log.msg}
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                </section>
            </main>
        </div>
    );
}