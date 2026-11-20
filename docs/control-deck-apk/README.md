# DPI 操作盤 Android アプリ（TWA）

操作盤（https://dpi-bot.com/site/control-deck/）を Chrome の Trusted Web Activity で全画面・横向き固定表示するアプリです。
ログインは Chrome 上の Cloudflare Access をそのまま使います。

- パッケージ名: `com.dpibot.controldeck` / アプリ名: DPI 操作盤 / minSdk 24（Android 7.0 以上）
- ビルド設定: `twa-manifest.json`（Bubblewrap 1.27.0 で生成・ビルド）
- 所有確認: `assetlinks.json`。本番では `worker/asset-links.js` が `/.well-known/assetlinks.json` として返します
  （`.assetsignore` が `.` で始まるパスを静的配信から外すため、Worker から返しています）。
- 署名鍵とパスワードはこのリポジトリに入れません（ビルド用 PC の `C:\Users\kazu\android-build\keys\`）。

## 作り直す手順（Windows）

前提: `C:\Users\kazu\android-build\` に JDK 17（`jdk17`）、Android SDK（`sdk`、build-tools 36.1.0 / android-36）、
Bubblewrap（`node_modules`）があり、`%USERPROFILE%\.bubblewrap\config.json` がそれらを指していること。

1. 版を上げる: `twa-manifest.json` の `appVersionCode` を 1 増やし、`appVersionName` / `appVersion` も更新する。
2. `twa-manifest.json` を `C:\Users\kazu\android-build\control-deck\` にコピーする。
3. PowerShell で実行する（Git Bash からだと `gradlew.bat` が見つからないことがあります）。

   ```powershell
   Set-Location C:\Users\kazu\android-build\control-deck
   Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
   ..\node_modules\.bin\bubblewrap.cmd update --skipVersionUpgrade
   $kv = Get-Content ..\keys\keystore-password.txt
   $env:BUBBLEWRAP_KEYSTORE_PASSWORD = ($kv | Where-Object { $_ -like 'store_password:*' }).Split(' ')[1]
   $env:BUBBLEWRAP_KEY_PASSWORD = ($kv | Where-Object { $_ -like 'key_password:*' }).Split(' ')[1]
   ..\node_modules\.bin\bubblewrap.cmd build --skipPwaValidation
   ```

4. **ビルド前に必ず次の 2 点を直す**（`bubblewrap update` で元に戻るため。直さないと起動直後にクラッシュします）。
   - `app/build.gradle` の `minifyEnabled true` を `false` に（R8 がライブラリの画面のクラス名を変えてしまう）
   - `app/src/main/AndroidManifest.xml` の `FocusActivity` の下に、次の宣言を足す
     （androidbrowserhelper 2.7 は起動時にこの画面の有効/無効を切り替えるため、宣言が無いと落ちる）

     ```xml
     <activity android:name="com.google.androidbrowserhelper.trusted.ManageDataLauncherActivity"
         android:exported="false">
         <meta-data android:name="android.support.customtabs.trusted.MANAGE_SPACE_URL"
             android:value="@string/launchUrl" />
     </activity>
     ```

   ※ `build.gradle` などを PowerShell の `Get-Content` で読み書きしないこと（UTF-8 が化けてアプリ名が文字化けする。1.0.2 で発生）。
   直したあとは `gradlew.bat assembleRelease` → `zipalign` → `apksigner sign` で作る（1.0.2 はこの手順）。
5. できた APK を端末に入れる（同じ鍵で署名していれば上書き更新できます）。
   入れる前にエミュレーター（`sdk\emulator`、AVD `deck34`）で `adb logcat -b crash` が空なことを確かめる。

注意:
- `webManifestUrl` は書かないでください。操作盤の manifest は Access で保護されており、Bubblewrap が取得に失敗します。
- 署名鍵をなくすと、同じアプリとして更新できなくなり、`assetlinks.json` の指紋も変更が必要になります。鍵は別の場所にも控えてください。
- 鍵を作り直した場合は `keytool -list -v` の SHA-256 を `worker/asset-links.js` と `assetlinks.json` の両方に反映します。
