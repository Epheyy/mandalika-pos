package com.mandalika.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Bluetooth Classic (RFCOMM / serial port profile) transport for receipt printers
 * such as the Rongta RPP02N that never answer BLE GATT discovery. Contract:
 * packages/printer/src/classicPlugin.ts and classicTypes.ts (CLASSIC_ERROR_CODES).
 *
 * Thread model: every @PluginMethod hands its work to ONE private single-thread
 * executor and resolves/rejects the call from there. Nothing blocking runs on
 * Capacitor's shared plugin thread, which OutboxJournal also uses. The connect
 * deadline runs on a separate scheduler thread because the executor thread is
 * blocked inside BluetoothSocket.connect(). The socket fields are only touched
 * on the executor thread, except the in-flight attempt, which is volatile so
 * the deadline can close it.
 */
@CapacitorPlugin(
        name = "ClassicPrinter",
        permissions = {
                @Permission(alias = "connect", strings = { Manifest.permission.BLUETOOTH_CONNECT })
        })
public class ClassicPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final long DEFAULT_TIMEOUT_MS = 10000L;

    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "ClassicPrinter-io");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ClassicPrinter-deadline");
        t.setDaemon(true);
        return t;
    });

    // Executor-thread only.
    private BluetoothSocket socket;
    private OutputStream out;

    // Shared with the deadline thread.
    private volatile BluetoothSocket attempt;
    private volatile boolean timedOut;

    private interface Op {
        void run(PluginCall call) throws Exception;
    }

    // ---- plugin methods (all return immediately) ----

    @PluginMethod
    public void listBonded(PluginCall call) {
        dispatch(call, this::doListBonded);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        dispatch(call, this::doConnect);
    }

    @PluginMethod
    public void write(PluginCall call) {
        // Needs no new permission: the socket already exists.
        submit(call, this::doWrite);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        submit(call, this::doDisconnect);
    }

    @PermissionCallback
    private void afterConnectPermission(PluginCall call) {
        if (getPermissionState("connect") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission denied", "PERMISSION_DENIED");
            return;
        }
        String method = call.getMethodName();
        if ("listBonded".equals(method)) {
            submit(call, this::doListBonded);
        } else if ("connect".equals(method)) {
            submit(call, this::doConnect);
        } else {
            call.reject("Unexpected method " + method, "CONNECT_FAILED");
        }
    }

    // ---- dispatch ----

    /** Checks the runtime Bluetooth permission (API 31+), then runs op on the executor. */
    private void dispatch(PluginCall call, Op op) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && getPermissionState("connect") != PermissionState.GRANTED) {
            requestPermissionForAlias("connect", call, "afterConnectPermission");
            return;
        }
        submit(call, op);
    }

    private void submit(PluginCall call, Op op) {
        try {
            executor.execute(() -> {
                try {
                    op.run(call);
                } catch (SecurityException e) {
                    closeQuietly();
                    call.reject("Bluetooth permission denied", "PERMISSION_DENIED");
                } catch (Exception e) {
                    call.reject(String.valueOf(e.getMessage()), "CONNECT_FAILED");
                }
            });
        } catch (RuntimeException e) {
            // Executor already shut down (activity destroyed).
            call.reject("Printer plugin stopped", "NOT_CONNECTED");
        }
    }

    // ---- operations (executor thread) ----

    private BluetoothAdapter adapterOrNull() {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return mgr == null ? null : mgr.getAdapter();
    }

    private void doListBonded(PluginCall call) {
        BluetoothAdapter adapter = adapterOrNull();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off", "BT_OFF");
            return;
        }
        JSArray devices = new JSArray();
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice d : bonded) {
                JSObject o = new JSObject();
                o.put("address", d.getAddress());
                String name = d.getName();
                o.put("name", name == null ? JSObject.NULL : name);
                o.put("type", typeName(d.getType()));
                o.put("hasSpp", hasSpp(d));
                devices.put(o);
            }
        }
        JSObject res = new JSObject();
        res.put("devices", devices);
        call.resolve(res);
    }

    private static String typeName(int type) {
        switch (type) {
            case BluetoothDevice.DEVICE_TYPE_CLASSIC:
                return "classic";
            case BluetoothDevice.DEVICE_TYPE_LE:
                return "le";
            case BluetoothDevice.DEVICE_TYPE_DUAL:
                return "dual";
            default:
                return "unknown";
        }
    }

    private static boolean hasSpp(BluetoothDevice d) {
        ParcelUuid[] uuids = d.getUuids(); // may be null
        if (uuids == null) return false;
        for (ParcelUuid u : uuids) {
            if (SPP_UUID.equals(u.getUuid())) return true;
        }
        return false;
    }

    private void doConnect(PluginCall call) throws IOException {
        closeQuietly();
        String address = call.getString("address");
        Long timeoutOpt = call.getLong("timeoutMs");
        long timeoutMs = timeoutOpt == null ? DEFAULT_TIMEOUT_MS : timeoutOpt;
        if (address == null) {
            call.reject("address is required", "NOT_BONDED");
            return;
        }
        BluetoothAdapter adapter = adapterOrNull();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off", "BT_OFF");
            return;
        }
        BluetoothDevice device = null;
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice d : bonded) {
                if (address.equalsIgnoreCase(d.getAddress())) {
                    device = d;
                    break;
                }
            }
        }
        if (device == null) {
            call.reject("Printer is not bonded", "NOT_BONDED");
            return;
        }
        cancelDiscoveryIfAllowed(adapter);

        timedOut = false;
        long deadlineAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        ScheduledFuture<?> deadline = deadlines.schedule(() -> {
            timedOut = true;
            BluetoothSocket s = attempt;
            if (s != null) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closing only to unblock connect()
                }
            }
        }, timeoutMs, TimeUnit.MILLISECONDS);

        BluetoothSocket connected = null;
        boolean secure = true;
        try {
            while (connected == null) {
                BluetoothSocket s = secure
                        ? device.createRfcommSocketToServiceRecord(SPP_UUID)
                        : device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                attempt = s;
                try {
                    if (timedOut) throw new IOException("deadline");
                    s.connect();
                    connected = s;
                } catch (IOException e) {
                    try {
                        s.close();
                    } catch (IOException ignored) {
                        // already failed
                    }
                    boolean outOfTime = timedOut || System.nanoTime() >= deadlineAt;
                    if (!secure || outOfTime) {
                        throw e;
                    }
                    secure = false; // retry once with the insecure record, within the remaining time
                }
            }
            socket = connected;
            out = connected.getOutputStream();
        } catch (IOException e) {
            attempt = null;
            deadline.cancel(false);
            call.reject(timedOut ? "Connect timeout" : String.valueOf(e.getMessage()),
                    timedOut ? "CONNECT_TIMEOUT" : "CONNECT_FAILED");
            return;
        }
        deadline.cancel(false);
        attempt = null;
        call.resolve();
    }

    private void cancelDiscoveryIfAllowed(BluetoothAdapter adapter) {
        boolean mayCancel = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                        == PackageManager.PERMISSION_GRANTED;
        if (!mayCancel) return;
        try {
            adapter.cancelDiscovery();
        } catch (SecurityException ignored) {
            // discovery is only a speed-up for connect()
        }
    }

    private void doWrite(PluginCall call) {
        if (socket == null || out == null) {
            call.reject("Printer is not connected", "NOT_CONNECTED");
            return;
        }
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required", "WRITE_FAILED");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            out.write(bytes);
            out.flush();
            call.resolve();
        } catch (IOException | IllegalArgumentException e) {
            closeQuietly();
            call.reject(String.valueOf(e.getMessage()), "WRITE_FAILED");
        }
    }

    private void doDisconnect(PluginCall call) {
        Integer drain = call.getInt("drainMs");
        if (drain != null && drain > 0 && socket != null) {
            try {
                Thread.sleep(drain); // executor thread: lets the printer empty its buffer
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        closeQuietly();
        call.resolve();
    }

    private void closeQuietly() {
        OutputStream o = out;
        BluetoothSocket s = socket;
        out = null;
        socket = null;
        if (o != null) {
            try {
                o.close();
            } catch (IOException ignored) {
                // best effort
            }
        }
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
                // best effort
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        // Close the socket first so a blocked write/connect fails fast, then stop the threads.
        BluetoothSocket a = attempt;
        if (a != null) {
            try {
                a.close();
            } catch (IOException ignored) {
                // shutting down
            }
        }
        closeQuietly();
        executor.shutdownNow();
        deadlines.shutdownNow();
        super.handleOnDestroy();
    }
}
