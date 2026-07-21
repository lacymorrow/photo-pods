declare module "qrcode" {
	export interface QRCodeToDataURLOptions {
		width?: number;
		margin?: number;
		color?: { dark?: string; light?: string };
		errorCorrectionLevel?: "L" | "M" | "Q" | "H";
	}
	const QRCode: {
		toDataURL(text: string, opts?: QRCodeToDataURLOptions): Promise<string>;
		toString(text: string, opts?: QRCodeToDataURLOptions): Promise<string>;
	};
	export default QRCode;
}
