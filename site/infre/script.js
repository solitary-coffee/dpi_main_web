document.addEventListener('DOMContentLoaded', function() {
    
    // --- ① メニュー開閉機能 ---
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.overlay');
    if (menuToggleBtn && sidebar && overlay) {
        menuToggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('open');
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
        });
    }

    // --- ③ アコーディオン機能 ---
    const commandTriggers = document.querySelectorAll('.command-trigger');
    if (commandTriggers.length > 0) {
        commandTriggers.forEach(trigger => {
            trigger.addEventListener('click', function() {
                this.classList.toggle('active');
                const content = this.nextElementSibling;
                if (content.style.maxHeight) {
                    content.style.maxHeight = null;
                } else {
                    content.style.maxHeight = content.scrollHeight + "px";
                }
            });
        });
    }

    // --- ⑤ 詳細ページの単一画像クリック切り替えギャラリー機能 ---
    const mainDisplayImage = document.getElementById('main-display-image');
    if (mainDisplayImage) {
        const imageList = [
            { src: '../images/eew-sample1.png', alt: '緊急地震速報のサンプル画面1' },
            { src: '../images/eew-sample2.png', alt: '緊急地震速報のサンプル画面2' },
            { src: '../images/eew-sample3.png', alt: '緊急地震速報のサンプル画面3' }
        ];
        let currentImageIndex = 0;
        const imageCaption = document.querySelector('.image-caption');
        const nextBtn = document.querySelector('.next-btn-onpage');
        const prevBtn = document.querySelector('.prev-btn-onpage');

        function updateImageDisplay() {
            if (currentImageIndex >= imageList.length) { currentImageIndex = 0; }
            if (currentImageIndex < 0) { currentImageIndex = imageList.length - 1; }
            mainDisplayImage.src = imageList[currentImageIndex].src;
            mainDisplayImage.alt = imageList[currentImageIndex].alt;
            imageCaption.textContent = imageList[currentImageIndex].alt;
        }
        updateImageDisplay();
        nextBtn.addEventListener('click', function() {
            currentImageIndex++;
            updateImageDisplay();
        });
        prevBtn.addEventListener('click', function() {
            currentImageIndex--;
            updateImageDisplay();
        });
    }

    // --- ⑥ 運用構成ページの単一画像ライトボックス機能 ---
    const singleLightboxTrigger = document.querySelector('.lightbox-trigger');
    if (singleLightboxTrigger) {
        const modal = document.getElementById('lightbox-modal');
        const modalImage = document.getElementById('modal-image');
        const captionText = document.getElementById('caption');

        if (modal && modalImage && captionText) {
            singleLightboxTrigger.addEventListener('click', function(e) {
                e.preventDefault();
                modal.style.display = "block";
                modalImage.src = this.href;
                captionText.innerHTML = this.querySelector('img').alt;
            });
            const closeBtn = modal.querySelector('.close-btn');
            closeBtn.addEventListener('click', () => {
                modal.style.display = "none";
            });
            modal.addEventListener('click', function(e) {
                if (e.target === modal) {
                    modal.style.display = "none";
                }
            });
        }
    }

}); 