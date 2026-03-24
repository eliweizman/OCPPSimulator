import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { useOcppConnection } from '@/features/ocpp/hooks';
import type { ChargePoint } from '@/features/ocpp/ocppSlice';
import { setTransactionId, updateConnectorStatus, setCablePlugged } from '@/features/ocpp/ocppSlice';
import { useBatteryState } from '@/hooks/useBatteryState';
import { getMeterForCp } from '@/services/meterModel';
import { Plug, PlugZap, Power, Activity, Lock, CreditCard, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch } from 'react-redux';

type PanelForm = {
  vendor: string;
  model: string;
};

interface ControlsPanelProps {
  cp: ChargePoint;
  deviceSettings?: {
    connectors?: number;
    socketType?: string[];
    deviceName?: string;
  };
}

export const ControlsPanel = ({ cp, deviceSettings }: ControlsPanelProps) => {
  const dispatch = useDispatch();
  const { call } = useOcppConnection(cp);
  const connected = cp.status === 'connected';
  const { beginCharge, endCharge, setMeterStart } = useBatteryState();
  const numConnectors = deviceSettings?.connectors || 1;
  const [selectedConnectorId, setSelectedConnectorId] = useState(1);
  const [nfcTag, setNfcTag] = useState('NFC_CARD_001');
  const [selectedStatus, setSelectedStatus] = useState('Available');

  const form = useForm<PanelForm>({
    defaultValues: {
      vendor: 'EVS-Sim',
      model: deviceSettings?.deviceName || 'Browser-CP',
    },
  });

  useEffect(() => {
    if (selectedConnectorId > numConnectors) {
      setSelectedConnectorId(1);
    }
  }, [numConnectors, selectedConnectorId]);

  const connectorId = selectedConnectorId;

  const onBoot = () => {
    const v = form.getValues();
    call.mutate({
      action: 'BootNotification',
      payload: {
        chargePointVendor: v.vendor || 'EVS-Sim',
        chargePointModel: v.model || 'Browser-CP',
      },
    });
  };

  const onHeartbeat = () => {
    call.mutate({ action: 'Heartbeat', payload: {} });
  };

  const onStatus = () => {
    call.mutate({
      action: 'StatusNotification',
      payload: {
        connectorId,
        status: selectedStatus,
        errorCode: 'NoError',
      },
    });
    dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: selectedStatus }));
  };

  const onAuthorize = async () => {
    // Real charger flow: if cable is plugged (Preparing) and no active tx,
    // tapping RFID card triggers full Authorize → StartTransaction → Charging
    const conn = cp.runtime?.connectors?.find(c => c.id === connectorId);
    const isPreparing = cablePlugged && !conn?.transactionId;

    await call.mutateAsync({
      action: 'Authorize',
      payload: { idTag: nfcTag || 'NFC_CARD_001' },
    });

    if (isPreparing) {
      // Auto-start transaction (same as real charger after RFID tap)
      const meterStart = Math.floor(1000 + Math.random() * 1000);
      const res = await call.mutateAsync({
        action: 'StartTransaction',
        payload: {
          connectorId,
          idTag: nfcTag || 'NFC_CARD_001',
          meterStart,
          timestamp: new Date().toISOString(),
        },
      });
      const txid =
        typeof (res as any)?.transactionId === 'number'
          ? (res as any).transactionId
          : Math.floor(Math.random() * 100000);
      dispatch(setTransactionId({ id: cp.id, connectorId, transactionId: txid }));
      await call.mutateAsync({
        action: 'StatusNotification',
        payload: { connectorId, status: 'Charging', errorCode: 'NoError' },
      });
      dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Charging' }));
      setMeterStart(meterStart);
      beginCharge(() => { onMeterValues(); });
    }
  };

  const onStartTx = async () => {
    const meterStart = Math.floor(1000 + Math.random() * 1000);
    try {
      await call.mutateAsync({
        action: 'Authorize',
        payload: { idTag: nfcTag || 'NFC_CARD_001' },
      });
    } catch {}
    const res = await call.mutateAsync({
      action: 'StartTransaction',
      payload: {
        connectorId,
        idTag: nfcTag || 'NFC_CARD_001',
        meterStart,
        timestamp: new Date().toISOString(),
      },
    });
    const txid =
      typeof (res as any)?.transactionId === 'number'
        ? (res as any).transactionId
        : Math.floor(Math.random() * 100000);
    dispatch(setTransactionId({ id: cp.id, connectorId, transactionId: txid }));
    await call.mutateAsync({
      action: 'StatusNotification',
      payload: {
        connectorId,
        status: 'Charging',
        errorCode: 'NoError',
      },
    });
    dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Charging' }));
    // begin local battery simulation and periodic MeterValues pushes
    setMeterStart(meterStart);
    beginCharge(() => {
      onMeterValues();
    });
  };

  const onMeterValues = () => {
    const meter = getMeterForCp(cp.id);
    meter?.tick().catch(() => {});
  };

  const onStopTx = async () => {
    const tx = cp.runtime?.connectors?.find(c => c.id === connectorId)?.transactionId || 0;
    let meterStop = 0;
    try {
      const m = getMeterForCp(cp.id);
      await m?.tick();
      const st = m?.getState(connectorId);
      meterStop = Math.floor(Math.max(0, Number(st?.energyWh || 0)));
    } catch {}
    await call.mutateAsync({
      action: 'StopTransaction',
      payload: {
        transactionId: tx,
        idTag: nfcTag || 'NFC_CARD_001',
        meterStop,
        timestamp: new Date().toISOString(),
        reason: 'Local',
      },
    });
    dispatch(setTransactionId({ id: cp.id, connectorId, transactionId: undefined }));
    await call.mutateAsync({
      action: 'StatusNotification',
      payload: {
        connectorId,
        status: 'Available',
        errorCode: 'NoError',
      },
    });
    dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Available' }));
    endCharge();
  };

  const onUnlockCable = async () => {
    await call.mutateAsync({
      action: 'StatusNotification',
      payload: {
        connectorId,
        status: 'Available',
        errorCode: 'NoError',
      },
    });
  };

  const connector = cp.runtime?.connectors?.find(c => c.id === connectorId);
  const cablePlugged = connector?.cablePlugged ?? false;
  const hasActiveTx = !!connector?.transactionId;
  const plugAndPlay = cp.chargePointConfig?.ocppConfig?.AllowOfflineTxForUnknownId ?? false;

  const onPlugCable = async () => {
    // Mark cable as plugged in Redux
    dispatch(setCablePlugged({ id: cp.id, connectorId, plugged: true }));

    // OCPP spec: Available → Preparing when cable is connected
    await call.mutateAsync({
      action: 'StatusNotification',
      payload: {
        connectorId,
        status: 'Preparing',
        errorCode: 'NoError',
      },
    });
    dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Preparing' }));

    // Plug & Play: auto-start transaction without waiting for RFID
    if (plugAndPlay) {
      const meterStart = Math.floor(1000 + Math.random() * 1000);
      const idTag = nfcTag || 'NFC_CARD_001';
      try {
        await call.mutateAsync({
          action: 'Authorize',
          payload: { idTag },
        });
      } catch { /* continue even if auth fails in P&P mode */ }
      const res = await call.mutateAsync({
        action: 'StartTransaction',
        payload: {
          connectorId,
          idTag,
          meterStart,
          timestamp: new Date().toISOString(),
        },
      });
      const txid =
        typeof (res as any)?.transactionId === 'number'
          ? (res as any).transactionId
          : Math.floor(Math.random() * 100000);
      dispatch(setTransactionId({ id: cp.id, connectorId, transactionId: txid }));
      await call.mutateAsync({
        action: 'StatusNotification',
        payload: {
          connectorId,
          status: 'Charging',
          errorCode: 'NoError',
        },
      });
      dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Charging' }));
      setMeterStart(meterStart);
      beginCharge(() => { onMeterValues(); });
    }
  };

  const onUnplugCable = async () => {
    // If there's an active transaction, stop it first (EV-side disconnect)
    if (hasActiveTx) {
      const tx = connector?.transactionId || 0;
      let meterStop = 0;
      try {
        const m = getMeterForCp(cp.id);
        await m?.tick();
        const st = m?.getState(connectorId);
        meterStop = Math.floor(Math.max(0, Number(st?.energyWh || 0)));
      } catch {}
      await call.mutateAsync({
        action: 'StopTransaction',
        payload: {
          transactionId: tx,
          idTag: nfcTag || 'NFC_CARD_001',
          meterStop,
          timestamp: new Date().toISOString(),
          reason: 'EVDisconnected',
        },
      });
      dispatch(setTransactionId({ id: cp.id, connectorId, transactionId: undefined }));
      endCharge();
    }

    // OCPP spec: transition through Finishing → Available when cable removed
    if (hasActiveTx || connector?.status === 'Charging' || connector?.status === 'SuspendedEV' || connector?.status === 'SuspendedEVSE') {
      await call.mutateAsync({
        action: 'StatusNotification',
        payload: { connectorId, status: 'Finishing', errorCode: 'NoError' },
      });
      dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Finishing' }));
    }

    await call.mutateAsync({
      action: 'StatusNotification',
      payload: { connectorId, status: 'Available', errorCode: 'NoError' },
    });
    dispatch(updateConnectorStatus({ id: cp.id, connectorId, status: 'Available' }));
    dispatch(setCablePlugged({ id: cp.id, connectorId, plugged: false }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Plug className='h-5 w-5' />
          OCPP Controls
          {deviceSettings?.deviceName && (
            <Badge variant='outline' className='ml-auto'>
              {deviceSettings.deviceName}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-6'>
        <div className='flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3'>
          <span className='font-medium text-sm'>Connector</span>
          <Select value={selectedConnectorId.toString()} onValueChange={(value) => setSelectedConnectorId(Number(value))}>
            <SelectTrigger className='w-32'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: numConnectors }, (_, i) => i + 1).map(id => (
                <SelectItem key={id} value={id.toString()}>
                  {id} - {deviceSettings?.socketType?.[id - 1] || 'Type2'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className='space-y-4'>
          {/* NFC / RFID Tag */}
          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <CreditCard className='h-3.5 w-3.5' />
              NFC / RFID Tag
            </div>
            <div className='flex items-center gap-2'>
              <Input
                value={nfcTag}
                onChange={(e) => setNfcTag(e.target.value)}
                placeholder='Enter NFC card ID (e.g. 04A3B2C1D2E3F4)'
                className='flex-1 h-9 text-sm font-mono'
              />
              <Button
                size='sm'
                variant='outline'
                onClick={onAuthorize}
                disabled={!connected}
                className='h-9 text-xs sm:text-sm whitespace-nowrap'
              >
                Tap Card
              </Button>
            </div>
          </div>

          <Separator />

          {/* Status Notification */}
          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <Activity className='h-3.5 w-3.5' />
              Connector Status
            </div>
            <div className='flex items-center gap-2'>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger className='w-48'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Reserved', 'Unavailable', 'Faulted'].map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size='sm'
                variant='outline'
                onClick={onStatus}
                disabled={!connected}
                className='h-9 text-xs sm:text-sm'
              >
                Send Status
              </Button>
            </div>
          </div>

          <Separator />

          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <Activity className='h-3.5 w-3.5' />
              Connection & Status
            </div>
            <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
              <Button 
                size='sm' 
                onClick={onBoot} 
                disabled={!connected}
                className='h-9 text-xs sm:text-sm'
              >
                BootNotification
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={onHeartbeat}
                disabled={!connected}
                className='h-9 text-xs sm:text-sm'
              >
                Heartbeat
              </Button>
            </div>
          </div>

          <Separator />

          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <Power className='h-3.5 w-3.5' />
              Transaction
            </div>
            <div className='grid grid-cols-2 sm:grid-cols-3 gap-2'>
              <Button
                size='sm'
                variant='secondary'
                onClick={onStartTx}
                disabled={
                  !connected || !!cp.runtime?.connectors?.find(c => c.id === connectorId)?.transactionId || !cablePlugged
                }
                className='h-9 text-xs sm:text-sm'
              >
                StartTx
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={onMeterValues}
                disabled={!connected}
                className='h-9 text-xs sm:text-sm'
              >
                MeterValues
              </Button>
              <Button
                size='sm'
                variant='destructive'
                onClick={onStopTx}
                disabled={
                  !connected || !cp.runtime?.connectors?.find(c => c.id === connectorId)?.transactionId
                }
                className='h-9 text-xs sm:text-sm'
              >
                StopTx
              </Button>
            </div>
          </div>

          <Separator />

          {/* Cable Connection (physical simulation) */}
          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <PlugZap className='h-3.5 w-3.5' />
              Cable Connection
              {cablePlugged && (
                <Badge variant='default' className='ml-auto text-[10px] px-1.5 py-0 bg-green-600'>
                  Plugged
                </Badge>
              )}
              {plugAndPlay && (
                <Badge variant='outline' className='text-[10px] px-1.5 py-0'>
                  P&P
                </Badge>
              )}
            </div>
            <div className='grid grid-cols-2 gap-2 max-w-md'>
              <Button
                size='sm'
                variant={cablePlugged ? 'outline' : 'default'}
                onClick={onPlugCable}
                disabled={!connected || cablePlugged}
                className='h-9 text-xs sm:text-sm'
              >
                <PlugZap className='h-3.5 w-3.5 mr-1' />
                Plug In Cable
              </Button>
              <Button
                size='sm'
                variant='destructive'
                onClick={onUnplugCable}
                disabled={!connected || !cablePlugged}
                className='h-9 text-xs sm:text-sm'
              >
                <Unplug className='h-3.5 w-3.5 mr-1' />
                Unplug Cable
              </Button>
            </div>
            {plugAndPlay && (
              <p className='text-[11px] text-muted-foreground'>
                Plug &amp; Play enabled — charging starts automatically when cable is connected
              </p>
            )}
          </div>

          <Separator />

          <div className='space-y-2.5'>
            <div className='flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              <Lock className='h-3.5 w-3.5' />
              Connector Control
            </div>
            <div className='grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md'>
              <Button
                size='sm'
                variant='secondary'
                onClick={onUnlockCable}
                disabled={!connected}
                className='h-9 text-xs sm:text-sm'
              >
                Unlock Cable
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default ControlsPanel;
