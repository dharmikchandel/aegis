import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, TextInput } from 'react-native';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';

// Default fallback for emulators
const DEFAULT_URL = Platform.OS === 'android' ? '10.0.2.2:8080' : '127.0.0.1:8080';

export default function HomeScreen() {
    const [isWalking, setIsWalking] = useState(false);
    const [showPrompt, setShowPrompt] = useState(false);
    const [status, setStatus] = useState('Disconnected');
    const [serverAddress, setServerAddress] = useState(DEFAULT_URL);
    const [riskState, setRiskState] = useState<'NORMAL' | 'WARNING' | 'DANGER'>('NORMAL');
    const riskStateRef = useRef(riskState);
    const [timeRemaining, setTimeRemaining] = useState(20);
    const showPromptRef = useRef(showPrompt);

    useEffect(() => {
        riskStateRef.current = riskState;
    }, [riskState]);

    useEffect(() => {
        showPromptRef.current = showPrompt;
    }, [showPrompt]);

    const ws = useRef<WebSocket | null>(null);
    const locationSub = useRef<Location.LocationSubscription | null>(null);
    const accelSub = useRef<any>(null);

    const telemetryInterval = useRef<ReturnType<typeof setInterval> | null>(null);

    // Latest telemetry data
    const currentLoc = useRef({ latitude: 0, longitude: 0, speed: 0 });
    const currentAccel = useRef(0);

    useEffect(() => {
        return () => {
            stopWalk();
        };
    }, []);

    const startWalk = async () => {
        try {
            const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
            if (locStatus !== 'granted') {
                alert('Permission to access location was denied');
                return;
            }

            // Connect WebSocket
            connectWebSocket();

            // Start Location
            locationSub.current = await Location.watchPositionAsync(
                {
                    accuracy: Location.Accuracy.High,
                    timeInterval: 2000,
                    distanceInterval: 1,
                },
                (loc) => {
                    currentLoc.current = {
                        latitude: loc.coords.latitude,
                        longitude: loc.coords.longitude,
                        speed: loc.coords.speed || 0,
                    };
                }
            );

            // Start Accelerometer
            Accelerometer.setUpdateInterval(500);
            accelSub.current = Accelerometer.addListener((accData) => {
                const mag = Math.sqrt(accData.x ** 2 + accData.y ** 2 + accData.z ** 2) * 9.81;
                currentAccel.current = mag;
            });

            setIsWalking(true);

            // Telemetry streaming interval
            const sessionID = "demo_user"; // Mock session ID
            telemetryInterval.current = setInterval(() => {
                if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                    const payload = {
                        sessionId: sessionID,
                        latitude: currentLoc.current.latitude,
                        longitude: currentLoc.current.longitude,
                        speed: currentLoc.current.speed,
                        accelerationMagnitude: currentAccel.current,
                        timestamp: new Date().toISOString(),
                    };
                    ws.current.send(JSON.stringify(payload));
                }
            }, 2000); // exactly every 2s per PRD
        } catch (err) {
            alert(`Setup Error: ${err}`);
            stopWalk();
        }
    };

    const connectWebSocket = () => {
        const wsUrl = `ws://${serverAddress.trim()}/ws`;
        console.log("Connecting to API:", wsUrl);
        setStatus(`Connecting...`);

        try {
            ws.current = new WebSocket(wsUrl);

            ws.current.onopen = () => {
                console.log("WebSocket Opened successfully");
                setStatus('Connected');
            };

            ws.current.onmessage = (e) => {
                // Gorilla batch concatenation support just in case
                const messages = typeof e.data === 'string' ? e.data.split('\n') : [e.data];

                messages.forEach(msg => {
                    if (!msg || msg.trim() === '') return;

                    try {
                        const data = JSON.parse(msg);
                        // A risk update payload will always have a "state" string (NORMAL, WARNING, DANGER)
                        if (data.state && typeof data.state === 'string') {
                            // Dumb Terminal Mode: Just render what the backend tells us
                            if (data.state === 'DANGER') {
                                setRiskState('DANGER');
                                setShowPrompt(true);
                            } else if (data.state === 'WARNING') {
                                setRiskState('WARNING');
                                if (data.escalationTimer !== undefined && data.escalationTimer > 0) {
                                    setShowPrompt(true);
                                    setTimeRemaining(data.escalationTimer);
                                } else {
                                    setShowPrompt(false);
                                }
                            } else {
                                setRiskState('NORMAL');
                                setShowPrompt(false);
                            }
                        }
                    } catch (err) {
                        console.error('JSON Parse error on mobile:', err);
                    }
                });
            };

            ws.current.onerror = (e) => {
                console.log("WebSocket Error encountered");
                setStatus('Connection Failed (Check IP & Firewall)');
            };

            ws.current.onclose = () => {
                console.log("WebSocket Closed");
                setStatus((prev) => prev.includes('Failed') ? prev : 'Disconnected');
            };
        } catch (err) {
            console.log("Failed to create WebSocket instance:", err);
            setStatus('Invalid Address Format');
        }
    };

    const stopWalk = () => {
        setIsWalking(false);

        if (locationSub.current) {
            locationSub.current.remove();
            locationSub.current = null;
        }
        if (accelSub.current) {
            accelSub.current.remove();
            accelSub.current = null;
        }
        if (telemetryInterval.current) {
            clearInterval(telemetryInterval.current);
            telemetryInterval.current = null;
        }
        if (ws.current) {
            ws.current.close();
            ws.current = null;
        }
        setStatus('Disconnected');
        setRiskState('NORMAL');
        setShowPrompt(false);
    };

    const confirmSafe = () => {
        setShowPrompt(false);
        setRiskState('NORMAL');

        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ action: "SAFE_ACK" }));
        }
    };

    const getBgColor = () => {
        if (riskState === 'DANGER') return '#ef4444'; // bright red-500
        if (riskState === 'WARNING') return '#eab308'; // bright yellow-500
        return '#09090b'; // zinc-950 for normal dark background
    };

    return (
        <View style={[styles.container, { backgroundColor: getBgColor() }]}>
            <View style={styles.header}>
                <Text style={styles.title}>Aegis</Text>
                <View style={styles.statusBadge}>
                    <View style={[styles.statusDot, status === 'Connected' ? styles.statusConnected : styles.statusDisconnected]} />
                    <Text style={styles.statusText}>{status}</Text>
                </View>
            </View>

            <View style={styles.content}>
                <Text style={styles.description}>
                    Aegis monitors your walk in real-time, detecting anomalies like sudden stops or running before you have to ask for help.
                </Text>

                {!isWalking ? (
                    <View style={styles.setupContainer}>
                        <Text style={styles.inputLabel}>Backend Address (LAN IP):</Text>
                        <TextInput
                            style={styles.input}
                            value={serverAddress}
                            onChangeText={setServerAddress}
                            placeholder="e.g. 192.168.1.5:8080"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity style={styles.primaryButton} onPress={startWalk}>
                            <Text style={styles.primaryButtonText}>I'm Heading Home</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <TouchableOpacity style={styles.destructiveButton} onPress={stopWalk}>
                        <Text style={styles.destructiveButtonText}>Stop Walk</Text>
                    </TouchableOpacity>
                )}
            </View>

            <Modal visible={showPrompt} animationType="slide" transparent>
                <View style={riskState === 'DANGER' ? styles.modalOverlayDanger : styles.modalOverlay}>
                    <View style={riskState === 'DANGER' ? styles.modalCardDanger : styles.modalCard}>
                        {riskState === 'DANGER' ? (
                            <>
                                <Text style={styles.modalTitleDanger}>DANGER</Text>
                                <Text style={styles.modalDescriptionDanger}>
                                    EMERGENCY ESCALATION ACTIVE.{'\n'}RESPOND IMMEDIATELY.
                                </Text>
                            </>
                        ) : (
                            <>
                                <Text style={styles.modalTitle}>Are you safe?</Text>
                                <Text style={styles.modalDescription}>
                                    We detected unusual activity. Escalating in {timeRemaining}s.
                                </Text>
                            </>
                        )}
                        <TouchableOpacity style={styles.primaryButton} onPress={confirmSafe}>
                            <Text style={styles.primaryButtonText}>Yes, I'm Safe</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#09090b', // zinc-950
        padding: 24,
    },
    header: {
        marginTop: 64,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 48,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        color: '#fafafa', // zinc-50
        letterSpacing: -0.5,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#18181b', // zinc-900
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: '#27272a', // zinc-800
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        marginRight: 6,
    },
    statusConnected: {
        backgroundColor: '#22c55e',
    },
    statusDisconnected: {
        backgroundColor: '#71717a', // zinc-500
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        color: '#a1a1aa', // zinc-400
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        paddingBottom: 64,
    },
    description: {
        fontSize: 16,
        color: '#a1a1aa', // zinc-400
        lineHeight: 24,
        marginBottom: 32,
        textAlign: 'center',
    },
    setupContainer: {
        gap: 16,
    },
    inputLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: '#e4e4e7', // zinc-200
    },
    input: {
        borderWidth: 1,
        borderColor: '#27272a', // zinc-800
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 16,
        color: '#fafafa', // zinc-50
        backgroundColor: '#09090b', // zinc-950
    },
    primaryButton: {
        backgroundColor: '#fafafa', // zinc-50
        paddingVertical: 16,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#e4e4e7', // zinc-200
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
    },
    primaryButtonText: {
        color: '#09090b', // zinc-950
        fontSize: 16,
        fontWeight: '600',
    },
    destructiveButton: {
        backgroundColor: '#7f1d1d', // red-900
        paddingVertical: 16,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#ef4444', // red-500
        alignItems: 'center',
        shadowColor: '#ef4444',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    destructiveButtonText: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '600',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(9, 9, 11, 0.8)', // zinc-950 80%
        justifyContent: 'center',
        padding: 24,
    },
    modalCard: {
        backgroundColor: '#09090b', // zinc-950
        borderRadius: 12,
        padding: 24,
        borderWidth: 1,
        borderColor: '#27272a', // zinc-800
        shadowColor: '#fafafa', // inner glow attempt via shadow
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.05,
        shadowRadius: 10,
        elevation: 4,
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#fafafa', // zinc-50
        marginBottom: 8,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    modalDescription: {
        fontSize: 15,
        color: '#a1a1aa', // zinc-400
        textAlign: 'center',
        marginBottom: 32,
        lineHeight: 22,
    },
    modalOverlayDanger: {
        flex: 1,
        backgroundColor: 'rgba(239, 68, 68, 0.9)', // red-500 90%
        justifyContent: 'center',
        padding: 24,
    },
    modalCardDanger: {
        backgroundColor: '#7f1d1d', // red-900
        borderRadius: 12,
        padding: 24,
        borderWidth: 2,
        borderColor: '#fca5a5', // red-300
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.5,
        shadowRadius: 24,
        elevation: 10,
    },
    modalTitleDanger: {
        fontSize: 28,
        fontWeight: '900',
        color: '#ffffff',
        marginBottom: 12,
        textAlign: 'center',
        letterSpacing: 2,
    },
    modalDescriptionDanger: {
        fontSize: 16,
        fontWeight: '700',
        color: '#fecaca', // red-200
        textAlign: 'center',
        marginBottom: 32,
        lineHeight: 24,
    },
});
