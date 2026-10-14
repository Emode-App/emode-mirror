import { Kiosk } from '@/components/kiosk/Kiosk';

// The mirror itself. Launched on a Proto Luma as
//   https://<host>/?device=<DEVICE_KEY>
// with Proto's "Include Serial Number" option adding &protoSerialNumber=...
export default function Page() {
    return <Kiosk />;
}
