'use strict';

const fs = require('fs');
const im = require('imagemagick');
const aws = require('aws-sdk');
const async = require('async');
const s3 = new aws.S3({apiVersion: '2006-03-01'});

exports.handler = (event, context, callback) => {
	const tmp = process.env.TEMP_DIR;
	const request = event.pathParameters.filename.split('/');
	const filename = request[0];
	const params = request[1] || '';

	var resizeStyle = new ResizeStyle(params);

	const bucket = {
		original: process.env.BUCKET_ORIGINAL, // read only
		cache: process.env.BUCKET_CACHE // read and write
	};
	const keyPrefix = {
		original: process.env.KEY_ORIGINAL,
		cache: process.env.KEY_CACHE
	};

	const basename = filename;
	const cachePath = filename + '_' + resizeStyle.getIndexName();
	const originalPath = filename;

	/**
	 * Download from S3
	 * @param args
	 * @param callback
	 */
	let download = (args, callback) => {
		s3.getObject(args, (err, response) => {
			if (err) {
				callback(err);
			} else {
				callback(null, response.Body, response.ContentType, response);
			}
		});
	};

	/**
	 * Upload to S3 
	 * @param body
	 * @param contentType
	 * @param callback
	 */
	let upload = (body, contentType, callback) => {
		s3.putObject({
			Bucket: bucket.cache,
			Key: keyPrefix.cache + cachePath,
			Body: body,
			ContentType: contentType
		}, (err) => {
			callback(err);
		});
	};
	
	/**
	 * アスペクト比固定のリサイズ
	 * @param body
	 * @param contentType
	 * @param callback
	 */
	let resize = (body, contentType, callback) => {
		im.resize({
			'srcData': body,
			'width': resizeStyle.getWidth(),
			'height': resizeStyle.getHeight(),
			'format': resizeStyle.getFormat(),
		}, (err, stdout, stderr) => {
			if (err) {
				callback(err);
			} else {
				var body = new Buffer(stdout, 'binary');
				callback(err, body, resizeStyle.getContentType());
			}
		});
	};

	/**
	 * レクタングル指定のリサイズ
	 * @param body
	 * @param contentType
	 * @param callback
	 */
	let convert = (body, contentType, callback) => {
		var tmpResized = tmp + basename + '_' + resizeStyle.getIndexName();
		var tmpCanvas = tmpResized + '_canvas.' + resizeStyle.getFormat();
		var tmpComposite = tmpResized + '_composite.' + resizeStyle.getFormat();
		
		im.identify({
			'data': body
		}, (err, result) => {
			if (err) {
				callback(err);
				return;
			}
			// 元画像の縦横を判定
			var original_w = result.width;
			var original_h = result.height;

			// リサイズ計算
			var [resized_w, resized_h] = resizeStyle.getResizeData(original_w, original_h);

			// 元画像をfit,fillに合わせてリサイズ
			im.resize({
				"srcData": body,
				'width': resized_w,
				'height': resized_h,
				'format': resizeStyle.getFormat(),
			}, (err, stdout, stderr) => {
				if (err) {
					callback(err);
					return;
				}
				let output = new Buffer(stdout, 'binary');
				fs.writeFile(tmpResized, output, (err) => {
					if (err) {
						callback(err);
						return;
					}
					// 指定サイズの無地レクタングルを作成
					im.convert([
						'-size',
						resizeStyle.getWidth() + 'x' + resizeStyle.getHeight(),
						"xc:" + resizeStyle.getColor(),
						tmpCanvas
					], (err, stdout) => {
						if (err) {
							callback(err);
							return;
						}
						// リサイズした画像とレクタングルを重ね合わせ
						im.convert([
							tmpCanvas,
							tmpResized,
							'-gravity',
							'center',
							'-composite',
							tmpComposite,
						], (err, stdout) => {
							if (err) {
								callback(err);
								return;
							}
							fs.readFile(tmpComposite, 'binary', (err, data) => {
								if (err) {
									callback(err);
									return;
								}
								var body = new Buffer(data, 'binary');
								// 変換後のコンテントタイプを指定
								callback(err, body, resizeStyle.getContentType());
							});
						});
					});
				});
			});
		});
	};

	async.waterfall(
		[
			// キャッシュを検索
			function (callback) {
				download({
					'Bucket': bucket.cache,
					'Key': keyPrefix.cache + cachePath
				}, (err, body, contentType) => {
					if (err) {
						// キャッシュなし
						callback(null);
					} else {
						// キャッシュあり
						callback(new ExistCacheException(body, contentType));
					}
				});
			},
			// オリジナルを検索
			function (callback) {
				download({
					'Bucket': bucket.original,
					'Key': keyPrefix.original + originalPath
				}, (err, body, contentType, response) => {
					if (err) {
						// オリジナル画像なし
						callback(new NotFoundException());
					} else {
						if ( response.Metadata.deleted ) {
							// 削除済み
							callback(new DeletedException());
						} else {
							// オリジナル画像あり
							callback(null, body, contentType);
						}
					}
				});
			},
			// リサイズ内容の検証
			function (body, contentType, callback) {
				// リサイズ不要
				if (!resizeStyle.isValid()) {
					// フルサイズをキャッシュ保存
					upload(body, contentType, (err) => {
						if (err) {
							callback(new UploadFailedException());
						} else {
							callback(new CouldNotResizeException(body, contentType));
						}
					});
				} else {
					callback(null, body, contentType);
				}
			},
			// リサイズ実行
			function (body, contentType, callback) {
				if (resizeStyle.isKeepAspect()) {
					// アスペクト比通り
					resize(body, contentType, (err, body, contentType) => {
						if (err) {
							callback(new ResizeFailedException());
						} else {
							callback(null, body, contentType);
						}
					});
				} else {
					// サイズ保証
					convert(body, contentType, (err, body, contentType) => {
						if (err) {
							callback(new ConvertFailedException());
						} else {
							callback(null, body, contentType);
						}
					});
				}
			},
			// リサイズ結果をキャッシュ保存
			function (body, contentType, callback) {
				// 変換ファイルの保存
				upload(body, contentType, (err) => {
					if (err) {
						callback(new UploadFailedException());
					} else {
						callback(null, new Magicked(body, contentType));
					}
				});
			}
		],
		// レスポンス処理
		function (err, magicked) {
			if (err) {
				console.log('catch exception');
				if (err instanceof NotFoundException) {
					console.log(err.message);
				} else if (err instanceof UploadFailedException) {
					console.log(err.message);
				} else if (err instanceof ResizeFailedException) {
					console.log(err.message);
				} else if (err instanceof ConvertFailedException) {
					console.log(err.message);
				} else if (err instanceof ExistCacheException) {
					// Valid Response
					console.log(err.payload.statusCode);
					callback(null, err.payload);
				} else if (err instanceof CouldNotResizeException) {
					// Valid Response
					console.log(err.payload.statusCode);
					callback(null, err.payload);
				}
			} else {
				// Valid Response
				console.log(magicked.payload.statusCode);
				callback(null, magicked.payload);
			}
		}
	);
};

class ResizeStyle {
	static get separator() {
		return '.';
	}
	static get maxDimension() {
		return 2048;
	}

	constructor(params) {
		let arr = [];
		let canvas = [];
		this.enable = true;
		if ('string' !== typeof params) {
			this.enable = false;
		} else {
			// fit or fill
			arr = params.split(ResizeStyle.separator);
			if (false === /^fi(t|ll)$/i.test(arr[0])) {
				this.enable = false;
				return;
			}
			this.cover = arr[0];
			// canvas rectangle
			if (false === /^([0-9]+x[0-9]*|[0-9]*x[0-9]+)$/.test(arr[1])) {
				this.enable = false;
				return;
			}
			canvas = arr[1].split('x');
			this.canvas_w_string = canvas[0] || '';
			this.canvas_h_string = canvas[1] || '';
			this.canvas_w = this.canvas_w_string || 0;
			this.canvas_h = this.canvas_h_string || 0;
			
			if ( this.canvas_w > ResizeStyle.maxDimension || this.canvas_h > ResizeStyle.maxDimension) {
				this.enable = false;
				return;
			}
			
			// image type
			if (/^(jpg|png|gif|)$/i.test(arr[2])) {
				this.format = arr[2];
			} else {
				this.format = 'jpg';
			}
			// canvas color
			if (/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(arr[3])) {
				this.background = arr[3];
			} else {
				this.background = 'none';
			}
		}
	}

	isValid() {
		return this.enable;
	}

	isKeepAspect() {
		return ( !this.canvas_w || !this.canvas_h )
	}

	getIndexName() {
		let name;
		if (this.isValid()) {
			// s3keyを生成
			name = this.cover
				+ ResizeStyle.separator
				+ this.canvas_w_string + 'x'
				+ this.canvas_h_string
				+ ResizeStyle.separator
				+ this.format
				+ ResizeStyle.separator
				+ this.background;
		} else {
			name = 'full';
		}

		return name.toLowerCase();
	}

	getWidth() {
		return this.canvas_w;
	}

	getHeight() {
		return this.canvas_h;
	}

	getFormat() {
		return this.format;
	}

	getContentType() {
		if ( 'jpg' === this.format ) {
			return 'image/jpeg';
		} else {
			return 'image/' + this.format;
		}
	}

	getColor() {
		if ('none' === this.background) {
			return this.background;
		} else {
			return '#' + this.background;
		}
	}

	getResizeData(original_w, original_h) {
		var resized_w,
			resized_h;
		if (original_w < original_h) {
			// 縦長
			if (this.cover === 'fit') {
				if (original_h < this.getHeight()) {
					resized_h = original_h;
				} else {
					resized_h = this.getHeight();
				}
				resized_w = 0;
			} else {
				if (original_w < this.getWidth()) {
					resized_w = original_w;
				} else {
					resized_w = this.getWidth();
				}
				resized_h = 0;
			}
		} else {
			// 横長 or 正方形
			if (this.cover === 'fit') {
				if (original_w < this.getWidth()) {
					resized_w = original_w;
				} else {
					resized_w = this.getWidth();
				}
				resized_h = 0;
			} else {
				if (original_h < this.getHeight()) {
					resized_h = original_h;
				} else {
					resized_h = this.getHeight();
				}
				resized_w = 0;
			}
		}
		return [resized_w, resized_h];
	}
}

class Payload {
	constructor() {
		this.statusCode = 200;
		this.headers = {};
		this.isBase64Encoded = true;
		this.body = '';
	}
}

class ExistCacheException {
	constructor(body, contentType) {
		this.payload = new Payload();
		this.payload.statusCode = 200;
		this.payload.headers = {'Content-Type': contentType};
		this.payload.body = new Buffer(body, 'binary').toString('base64');
	}
}

class NotFoundException {
	constructor() {
		this.message = 'Not Found Exception';
	}
}

class CouldNotResizeException {
	constructor(body, contentType) {
		this.payload = new Payload();
		this.payload.statusCode = 200;
		this.payload.headers = {'Content-Type': contentType};
		this.payload.body = new Buffer(body, 'binary').toString('base64');
	}
}

class UploadFailedException {
	constructor() {
		this.message = 'Upload Failed Exception';
	}
}

class ResizeFailedException {
	constructor() {
		this.message = 'Resize Failed Exception';
	}
}

class ConvertFailedException {
	constructor() {
		this.message = 'Convert Failed Exception';
	}
}

class DeletedException {
	constructor() {
		this.message = 'Deleted Exception';
	}
}

class Magicked {
	constructor(body, contentType) {
		this.payload = new Payload();
		this.payload.statusCode = 200;
		this.payload.headers = {'Content-Type': contentType};
		this.payload.body = new Buffer(body, 'binary').toString('base64');
	}
}
