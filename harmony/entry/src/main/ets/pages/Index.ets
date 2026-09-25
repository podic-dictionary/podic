import { common, bundleManager } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { resourceManager } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';
import { startServer } from 'libpodic_ohos.so';

const DOMAIN = 0x0000;
const TAG = 'podic';
const COPY_CHUNK = 1 << 20;

/**
 * 把 HAP rawfile 里的 web/ 与 packs/*.db 落到沙箱 dataDir：
 * - web：随版本升级全量替换
 * - packs：只补缺失，绝不覆盖用户自导入/更新过的包
 * 文件清单在构建期生成（web-manifest.json / packs-manifest.json），
 * 运行期不依赖 resourceManager.getRawFileList（该接口对目录的列举行为不稳定）。
 */
async function installAssets(ctx: common.UIAbilityContext, dataDir: string): Promise<void> {
  if (!fs.accessSync(dataDir)) {
    fs.mkdirSync(dataDir, true);
  }
  const mgr = ctx.resourceManager;
  const versionCode = bundleManager.getBundleInfoForSelfSync(
    bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
  ).versionCode;

  const marker = dataDir + '/installed_version';
  let installed = '';
  try {
    installed = fs.readTextSync(marker);
  } catch (err) {
    installed = '';
  }

  if (installed.trim() !== String(versionCode)) {
    const webDir = dataDir + '/web';
    removeDir(webDir);
    const files = await readRawManifest(mgr, 'web-manifest.json');
    for (const rel of files) {
      const dest = webDir + '/' + rel;
      const parent = parentDir(dest);
      if (!fs.accessSync(parent)) {
        fs.mkdirSync(parent, true);
      }
      await copyRawFile(mgr, 'web/' + rel, dest);
    }
  }

  const packsDir = dataDir + '/packs';
  if (!fs.accessSync(packsDir)) {
    fs.mkdirSync(packsDir, true);
  }
  const packs = await readRawManifest(mgr, 'packs-manifest.json');
  for (const name of packs) {
    const dest = packsDir + '/' + name;
    if (fs.accessSync(dest)) {
      continue;
    }
    await copyRawFile(mgr, 'packs/' + name, dest);
  }

  const markerFile = fs.openSync(
    marker,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC
  );
  try {
    fs.writeSync(markerFile.fd, String(versionCode));
  } finally {
    fs.closeSync(markerFile);
  }
}

/** 取父目录（POSIX 分隔符），无分隔符时返回自身 */
function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.substring(0, idx) : path;
}

/** 递归删除沙箱目录（rmdirSync 不递归；沙箱目录很浅，进程内同步删除即可） */
function removeDir(path: string): void {
  if (!fs.accessSync(path)) {
    return;
  }
  for (const name of fs.listFileSync(path)) {
    const child = path + '/' + name;
    if (fs.statSync(child).isDirectory()) {
      removeDir(child);
    } else {
      fs.unlinkSync(child);
    }
  }
  fs.rmdirSync(path);
}

/** 读取构建期生成的 rawfile 文件清单（UTF-8 JSON 字符串数组） */
async function readRawManifest(
  mgr: resourceManager.ResourceManager,
  rawPath: string
): Promise<string[]> {
  const src = await mgr.getRawFd(rawPath);
  let text = '';
  try {
    const buf = new ArrayBuffer(src.length);
    const read = fs.readSync(src.fd, buf, { offset: src.offset, length: src.length });
    text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf, 0, read));
  } finally {
    await mgr.closeRawFd(rawPath);
  }
  return JSON.parse(text) as string[];
}

/** 单个 rawfile -> 沙箱文件（按 RawFileDescriptor 的 offset/length 分块拷贝，避免大词典包整包进内存） */
async function copyRawFile(
  mgr: resourceManager.ResourceManager,
  rawPath: string,
  destPath: string
): Promise<void> {
  // rawfile 的 fd 指向整个 HAP：必须按 offset/length 取这一段，
  // 直接 copyFileSync(src.fd, dst.fd) 会把 HAP 原始字节整段拷出来。
  const src = await mgr.getRawFd(rawPath);
  const dst = fs.openSync(
    destPath,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC
  );
  try {
    let done = 0;
    while (done < src.length) {
      const want = Math.min(COPY_CHUNK, src.length - done);
      const buf = new ArrayBuffer(want);
      const read = fs.readSync(src.fd, buf, { offset: src.offset + done, length: want });
      if (read <= 0) {
        break;
      }
      const out = read === want ? buf : buf.slice(0, read);
      let written = 0;
      while (written < read) {
        const w = fs.writeSync(dst.fd, out.slice(written), { length: read - written });
        if (w <= 0) {
          throw new Error(`write rawfile failed: ${rawPath}`);
        }
        written += w;
      }
      done += read;
    }
  } finally {
    fs.closeSync(dst);
    await mgr.closeRawFd(rawPath);
  }
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State url: string = '';
  @State tip: string = '正在准备词典数据…';
  // 「能否应用内返回」由前端经 PodicHarmony 桥同步（Web 的 canGoBack 不认 pushState）
  private canGoBackInApp: boolean = false;

  aboutToAppear(): void {
    this.boot();
  }

  async boot(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    const dataDir = ctx.filesDir + '/data';
    try {
      await installAssets(ctx, dataDir);
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'assets install: code=%{public}d msg=%{public}s', e.code, e.message);
    }
    const port = startServer(dataDir, 0); // 0 = 内核挑空闲端口，杜绝端口冲突
    if (port > 0) {
      this.url = `http://127.0.0.1:${port}`;
    } else {
      this.tip = 'podic 后端启动失败，请重启应用';
    }
  }

  build() {
    Stack() {
      if (this.url.length > 0) {
        Web({ src: this.url, controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .javaScriptProxy({
            object: {
              setCanGoBack: (v: boolean): void => {
                this.canGoBackInApp = v;
              }
            },
            name: 'PodicHarmony',
            methodList: ['setCanGoBack'],
            controller: this.controller
          })
      } else {
        Column() {
          Text(this.tip)
            .fontSize(16)
            .fontColor($r('sys.color.font_secondary'))
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }

  // 返回语义：能应用内返回就交给前端回上级；查词栈底弹退出确认
  onBackPress(): boolean {
    if (this.canGoBackInApp) {
      this.controller
        .runJavaScript('window.__podicGoBack && window.__podicGoBack()')
        .catch((err: Error) => {
          hilog.error(DOMAIN, TAG, 'goBack: %{public}s', err.message);
        });
      return true;
    }
    promptAction
      .showDialog({
        message: '退出 Podic？',
        buttons: [
          { text: '取消', color: $r('sys.color.font_primary') },
          { text: '退出', color: $r('sys.color.warning') }
        ]
      })
      .then((res: promptAction.ShowDialogSuccessResponse) => {
        if (res.index === 1) {
          (getContext(this) as common.UIAbilityContext).terminateSelf();
        }
      })
      .catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'exit dialog: %{public}s', err.message);
      });
    return true;
  }
}
