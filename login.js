const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

// Output format configuration: 'jpg' (100% quality) or 'png'
const OUTPUT_FORMAT = (process.env.OUTPUT_FORMAT || 'jpg').toLowerCase();

// Helper to generate a temporary email from the EduMails API
async function generateTemporaryEmail() {
  console.log('Generating temporary email from EduMails API...');
  const response = await fetch('https://api.edu-mails.com/api/emails/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'random' })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to generate email: ${response.status} ${await response.text()}`);
  }
  
  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(`EduMails API returned error: ${JSON.stringify(result)}`);
  }
  
  const { uuid, address } = result.data.email;
  console.log(`Generated Email: ${address} (UUID: ${uuid})`);
  return { uuid, address };
}

// Helper to poll the inbox for the verification link
async function pollForVerificationLink(uuid, maxAttempts = 24, intervalMs = 5000) {
  console.log(`Polling inbox for verification email (UUID: ${uuid})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Attempt ${attempt}/${maxAttempts}: Checking inbox...`);
    const response = await fetch(`https://api.edu-mails.com/api/emails/${uuid}`);
    
    if (!response.ok) {
      console.log(`API returned status ${response.status}. Retrying in ${intervalMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      continue;
    }
    
    const result = await response.json();
    if (result.status === 'success' && result.data && result.data.messages && result.data.messages.length > 0) {
      console.log(`Received ${result.data.messages.length} message(s).`);
      
      // Look for the verification email
      for (const message of result.data.messages) {
        console.log(`Subject: "${message.subject}" from "${message.from}"`);
        
        const body = message.body || '';
        
        // Extract all links matching http/https pattern
        const urlRegex = /https?:\/\/[^\s"'<>]+/g;
        const allUrls = [...new Set(body.match(urlRegex) || [])];
        
        console.log(`Parsed ${allUrls.length} total links from email body.`);
        
        // 1. Try to find the direct vanceai.com validation URL in the email
        const directLink = allUrls.find(url => 
          url.includes('vanceai.com') && 
          url.includes('register') && 
          url.includes('hash_code')
        );

        if (directLink) {
          const verificationLink = directLink.replace(/&amp;/g, '&');
          console.log(`Successfully found and cleaned direct verification link: ${verificationLink}`);
          return verificationLink;
        }

        // 2. Fallback to Mailgun redirect link that handles the redirect to vanceai.com
        const redirectLink = allUrls.find(url => 
          url.includes('vanceai.com') && 
          url.includes('/c/')
        );

        if (redirectLink) {
          const verificationLink = redirectLink.replace(/&amp;/g, '&');
          console.log(`Successfully found and cleaned tracking redirect link: ${verificationLink}`);
          return verificationLink;
        }
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout: No verification email containing a vanceai.com link was received.`);
}

// Helper to download ZIP from url
async function downloadZip(url, dest) {
  try {
    console.log(`Downloading ZIP from ${url} to ${dest}...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(dest, buffer);
    console.log('ZIP download complete.');
  } catch (error) {
    console.error(`Failed to download ZIP from URL: ${error.message}`);
    throw error;
  }
}

// Recursively find all image files in a directory
function getImages(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getImages(filePath));
    } else {
      const ext = path.extname(file).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        results.push(filePath);
      }
    }
  });
  return results;
}

async function run() {
  let zipPath = path.join(__dirname, 'input.zip');
  
  // Download ZIP if ZIP_URL is provided
  if (process.env.ZIP_URL && process.env.ZIP_URL.trim() !== '') {
    await downloadZip(process.env.ZIP_URL, zipPath);
  }
  
  // Create mock input.zip for testing if none exists
  if (!fs.existsSync(zipPath)) {
    console.log('No input.zip found and ZIP_URL is not set.');
    const mockImage = path.join(__dirname, '1-homepage.png');
    if (!fs.existsSync(mockImage)) {
      console.log('Creating a mock 1x1 transparent PNG image...');
      const dummyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      fs.writeFileSync(mockImage, Buffer.from(dummyPngBase64, 'base64'));
    }
    console.log('Creating a mock input.zip with mock image for end-to-end testing...');
    const zip = new AdmZip();
    zip.addLocalFile(mockImage);
    zip.writeZip(zipPath);
  }

  // Extract Zip
  console.log('Extracting wallpapers...');
  const zip = new AdmZip(zipPath);
  const inputDir = path.join(__dirname, 'wallpapers-input');
  if (fs.existsSync(inputDir)) {
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(inputDir);
  zip.extractAllTo(inputDir, true);

  const imagesToProcess = getImages(inputDir);
  console.log(`Found ${imagesToProcess.length} images to upscale.`);
  
  if (imagesToProcess.length === 0) {
    console.log('No images found in the zip file. Exiting.');
    process.exit(0);
  }

  // Setup Output Directory
  const outputDir = path.join(__dirname, 'wallpapers-output');
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir);

  // Shared state index pointer
  let activeIndex = 0;
  function getNextImageIndex() {
    if (activeIndex >= imagesToProcess.length) {
      return -1;
    }
    const idx = activeIndex;
    activeIndex++;
    return idx;
  }

  // Concurrent Worker Definition
  async function runWorker(workerId) {
    console.log(`[Worker ${workerId}] Started.`);
    
    while (true) {
      // Pull first task index
      const firstIdx = getNextImageIndex();
      if (firstIdx === -1) {
        break; // No tasks left
      }
      
      console.log(`[Worker ${workerId}] Registering new VanceAI account...`);
      const passwordVal = 'Shawon63@@';
      const { uuid, address: generatedEmail } = await generateTemporaryEmail();

      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();

      // Navigate to VanceAI homepage
      await page.goto('https://vanceai.com/', { waitUntil: 'load', timeout: 60000 });

      // Locate and click the "Log in" button
      const loginButton = page.locator('button:has-text("Log in")').first();
      await loginButton.waitFor({ state: 'visible', timeout: 20000 });
      await loginButton.click();
      
      const signInButton = page.locator('button:has-text("Sign in")').first();
      await signInButton.waitFor({ state: 'visible', timeout: 15000 });
      await signInButton.click();
      
      // Click "Sign up"
      const signUpButton = page.locator('button:has-text("Sign up")').first();
      await signUpButton.waitFor({ state: 'visible', timeout: 15000 });
      await signUpButton.click();

      // Fill Sign up email
      const emailInput = page.locator('input#signup-email, input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      await emailInput.fill(generatedEmail);

      // Submit
      const submitButton = page.locator('button[type="submit"], button:has-text("Send sign up link")').first();
      await submitButton.click();
      await page.waitForTimeout(3000);

      // Poll for validation link
      const verificationLink = await pollForVerificationLink(uuid);

      // Navigate to validation link
      await page.goto(verificationLink, { waitUntil: 'load', timeout: 60000 });

      // Complete profile
      const firstNameInput = page.locator('input[autocomplete="given-name"], input[placeholder="Jane"]').first();
      await firstNameInput.waitFor({ state: 'visible', timeout: 20000 });

      const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth'];
      const lastNames = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Robinson', 'Wright'];
      const randomFirstName = firstNames[Math.floor(Math.random() * firstNames.length)];
      const randomLastName = lastNames[Math.floor(Math.random() * lastNames.length)];

      await firstNameInput.fill(randomFirstName);
      const lastNameInput = page.locator('input[autocomplete="family-name"], input[placeholder="Doe"]').first();
      await lastNameInput.fill(randomLastName);

      const passwordInput = page.locator('input[placeholder="Min. 8 characters"]').first();
      await passwordInput.fill(passwordVal);
      const confirmPasswordInput = page.locator('input[placeholder="Re-enter password"]').first();
      await confirmPasswordInput.fill(passwordVal);

      const termsCheckbox = page.locator('input[type="checkbox"]').first();
      await termsCheckbox.check({ force: true });

      const completeSignUpButton = page.locator('button[type="submit"], button:has-text("Complete sign up")').first();
      await completeSignUpButton.click();
      await page.waitForTimeout(20000); 

      // Close registration page and open fresh login context
      await page.close();
      await context.close();

      console.log(`[Worker ${workerId}] Opening clean login session for: ${generatedEmail}`);
      const loginContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      const loginPage = await loginContext.newPage();

      // Login fresh
      await loginPage.goto('https://vanceai.com/', { waitUntil: 'load', timeout: 60000 });

      const loginButton2 = loginPage.locator('button:has-text("Log in")').first();
      await loginButton2.waitFor({ state: 'visible', timeout: 20000 });
      await loginButton2.click();

      const signInButton2 = loginPage.locator('button:has-text("Sign in")').first();
      await signInButton2.waitFor({ state: 'visible', timeout: 15000 });
      await signInButton2.click();

      const loginEmailInput = loginPage.locator('input[autocomplete="username"], input[type="email"]').first();
      await loginEmailInput.waitFor({ state: 'visible', timeout: 20000 });

      await loginEmailInput.fill(generatedEmail);
      const loginPasswordInput = loginPage.locator('input[autocomplete="current-password"], input[type="password"]').first();
      await loginPasswordInput.fill(passwordVal);

      const completeSignInButton = loginPage.locator('form button[type="submit"], form button:has-text("Sign in")').first();
      await completeSignInButton.click();

      // Wait for Dashboard to load
      const workspaceLink = loginPage.locator('a[aria-label="Workspace"], a[href="/workspace-new/"], a:has-text("My Studio"), a[href*="workspace"], button:has-text("My Studio")').first();
      await workspaceLink.waitFor({ state: 'visible', timeout: 30000 });

      // Click Workspace/My Studio
      const mobileWorkspaceLink = loginPage.locator('a[aria-label="Workspace"], a[href="/workspace-new/"]').first();
      const desktopMyStudioLink = loginPage.locator('a:has-text("My Studio"), a[href*="workspace"], button:has-text("My Studio")').first();

      if (await mobileWorkspaceLink.isVisible()) {
        await mobileWorkspaceLink.click();
      } else if (await desktopMyStudioLink.isVisible()) {
        await desktopMyStudioLink.click();
      } else {
        const fallbackLink = loginPage.locator('a[href*="workspace"]').first();
        await fallbackLink.waitFor({ state: 'visible', timeout: 15000 });
        await fallbackLink.click();
      }

      // Wait for the Workspace upload interface to load
      const uploadTrigger = loginPage.locator('[data-testid="workspace-upload-trigger"]').first();
      await uploadTrigger.waitFor({ state: 'visible', timeout: 25000 });
      
      const studioUrl = loginPage.url();

      let accountCreditsUsed = 0;
      let currentImageIndex = firstIdx;

      while (accountCreditsUsed < 5 && currentImageIndex !== -1) {
        const currentImage = imagesToProcess[currentImageIndex];
        const filename = path.basename(currentImage);
        console.log(`[Worker ${workerId}] [Image ${accountCreditsUsed + 1}/5] Processing: ${filename}`);

        // If not the first upload in this session, navigate back to a clean upload screen
        if (accountCreditsUsed > 0) {
          await loginPage.goto(studioUrl, { waitUntil: 'load', timeout: 45000 });
          await uploadTrigger.waitFor({ state: 'visible', timeout: 25000 });
        }

        // Listen for the filechooser event
        const fileChooserPromise = loginPage.waitForEvent('filechooser');
        await uploadTrigger.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(currentImage);
        
        // Wait for image upload to complete (upload trigger disappears)
        await uploadTrigger.waitFor({ state: 'hidden', timeout: 30000 });
        await loginPage.waitForTimeout(2000);

        // Select tool and scale configurations
        const enhanceTabButton = loginPage.locator('button:has-text("Enhance")').first();
        if (await enhanceTabButton.isVisible()) {
          await enhanceTabButton.click();
        }

        const scale2xButton = loginPage.locator('button:has-text("2x")').first();
        await scale2xButton.waitFor({ state: 'visible', timeout: 15000 });
        await scale2xButton.click();

        const enhanceFaceToggle = loginPage.locator('button[aria-label="Enhance face"], button[role="switch"]:has-text("Enhance face"), button:has-text("Enhance face")').first();
        if (await enhanceFaceToggle.isVisible()) {
          const isPressed = await enhanceFaceToggle.getAttribute('aria-pressed');
          const isChecked = await enhanceFaceToggle.getAttribute('aria-checked');
          if (isPressed === 'true' || isChecked === 'true') {
            await enhanceFaceToggle.click();
          }
        } else {
          const mobileToggleContainer = loginPage.locator('div:has-text("Enhance face") button[role="switch"]').first();
          if (await mobileToggleContainer.isVisible()) {
            const isChecked = await mobileToggleContainer.getAttribute('aria-checked');
            if (isChecked === 'true') {
              await mobileToggleContainer.click();
            }
          }
        }

        const processButton = loginPage.locator('button:has-text("Process"), button:has-text("Start to process")').first();
        await processButton.waitFor({ state: 'visible', timeout: 15000 });
        await processButton.click();

        // Check if "Upgrade your plan to keep going" modal interrupts
        const upgradeModalClose = loginPage.locator('div[role="dialog"] button[aria-label="Close"], button:has-text("Maybe later")').first();
        try {
          await upgradeModalClose.waitFor({ state: 'visible', timeout: 5000 });
          await upgradeModalClose.click();
          await loginPage.waitForTimeout(1000);
        } catch (err) {
          // Modal did not appear
        }

        // Wait for "Hold to compare" button to appear (indicating upscale is complete)
        const holdToCompareButton = loginPage.locator('text=Hold to compare').first();
        await holdToCompareButton.waitFor({ state: 'visible', timeout: 120000 });

        // Retrieve upscaled image (Method 1: Direct Blob extraction, Method 2: Button download fallback)
        let downloadSuccess = false;
        const fileExtension = OUTPUT_FORMAT === 'png' ? 'png' : 'jpg';
        const targetFilename = `${path.basename(currentImage, path.extname(currentImage))}-upscaled.${fileExtension}`;
        const finalDownloadPath = path.join(outputDir, targetFilename);

        try {
          const processedImg = loginPage.locator('img[alt="Processed image"]').first();
          await processedImg.waitFor({ state: 'visible', timeout: 15000 });
          const blobUrl = await processedImg.getAttribute('src');
          
          if (blobUrl && blobUrl.startsWith('blob:')) {
            const base64Data = await loginPage.evaluate(async ({ url, format }) => {
              const response = await fetch(url);
              const blob = await response.blob();
              
              const img = new Image();
              img.src = URL.createObjectURL(blob);
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
              });
              
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              
              let mimeType = 'image/png';
              let quality = undefined;
              if (format === 'jpg' || format === 'jpeg') {
                mimeType = 'image/jpeg';
                quality = 1.0;
              }
              
              const dataUrl = canvas.toDataURL(mimeType, quality);
              URL.revokeObjectURL(img.src);
              return dataUrl.split(',')[1];
            }, { url: blobUrl, format: OUTPUT_FORMAT });

            fs.writeFileSync(finalDownloadPath, Buffer.from(base64Data, 'base64'));
            console.log(`[Worker ${workerId}] Successfully downloaded and saved image to: ${finalDownloadPath}`);
            downloadSuccess = true;
          }
        } catch (blobError) {
          console.log(`[Worker ${workerId}] Blob download method failed: ${blobError.message}. Proceeding to fallback method...`);
        }

        if (!downloadSuccess) {
          try {
            const downloadButton = loginPage.locator('button:has-text("Download"), a:has-text("Download"), [aria-label*="Download"]').filter({ visible: true }).first();
            await downloadButton.waitFor({ state: 'visible', timeout: 20000 });
            
            const downloadPromise = loginPage.waitForEvent('download');
            await downloadButton.click();
            
            const download = await downloadPromise;
            const downloadedExtension = path.extname(download.suggestedFilename()).toLowerCase();
            const tempPath = path.join(outputDir, `temp-w${workerId}-${filename}${downloadedExtension}`);
            await download.saveAs(tempPath);
            
            const fileBuffer = fs.readFileSync(tempPath);
            const base64Input = fileBuffer.toString('base64');
            const mimeTypeInput = downloadedExtension === '.png' ? 'image/png' : 'image/jpeg';
            
            const base64Output = await loginPage.evaluate(async ({ base64, mimeInput, format }) => {
              const img = new Image();
              img.src = `data:${mimeInput};base64,${base64}`;
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
              });
              
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              
              let mimeTypeOutput = 'image/png';
              let quality = undefined;
              if (format === 'jpg' || format === 'jpeg') {
                mimeTypeOutput = 'image/jpeg';
                quality = 1.0;
              }
              return canvas.toDataURL(mimeTypeOutput, quality).split(',')[1];
            }, { base64: base64Input, mimeInput: mimeTypeInput, format: OUTPUT_FORMAT });
            
            fs.writeFileSync(finalDownloadPath, Buffer.from(base64Output, 'base64'));
            fs.unlinkSync(tempPath); // Clean up temp file
            console.log(`[Worker ${workerId}] Successfully saved image via fallback to: ${finalDownloadPath}`);
            downloadSuccess = true;
          } catch (buttonError) {
            console.error(`[Worker ${workerId}] Download button method failed: ${buttonError.message}`);
          }
        }

        if (downloadSuccess) {
          accountCreditsUsed++;
        }
        
        // If we still have credits left for this session, pull the next task index
        if (accountCreditsUsed < 5) {
          currentImageIndex = getNextImageIndex();
        } else {
          currentImageIndex = -1;
        }
      }

      console.log(`[Worker ${workerId}] Closing browser session for this account...`);
      await loginPage.close();
      await loginContext.close();
      await browser.close();
    }
    
    console.log(`[Worker ${workerId}] All assigned tasks complete.`);
  }

  // Launch 5 workers concurrently
  const NUM_WORKERS = 5;
  console.log(`Launching ${NUM_WORKERS} concurrent workers...`);
  
  const workers = [];
  for (let w = 1; w <= NUM_WORKERS; w++) {
    workers.push(runWorker(w));
  }
  
  // Wait for all workers to finish
  await Promise.all(workers);

  // Create Final output.zip
  console.log('\n========================================');
  console.log('CREATING FINAL ZIP OF ALL PROCESSES WALLPAPERS');
  console.log('========================================');
  
  const finalZipPath = path.join(__dirname, 'output.zip');
  if (fs.existsSync(finalZipPath)) {
    fs.unlinkSync(finalZipPath);
  }
  const finalZip = new AdmZip();
  finalZip.addLocalFolder(outputDir);
  finalZip.writeZip(finalZipPath);
  console.log(`Successfully created final zip: ${finalZipPath}`);

  // Clean up input folder
  if (fs.existsSync(inputDir)) {
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error('An error occurred during execution:', error);
  process.exit(1);
});
